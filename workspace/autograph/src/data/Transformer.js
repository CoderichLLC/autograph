const Util = require('@coderich/util');

module.exports = class Transformer {
  #config = {
    args: {}, // Arguments passed to each thunk
    shape: {}, // The final shape
    defaults: {}, // Default values applied at beginning of transformation
    strictSchema: false, // If true, will strip away unknown attributes
    keepUndefined: false, // If true, will preserve undefined values
  };

  #callArgs = {}; // Ephemeral per-call merge of #config.args + transform() args; never persisted

  // Proxy handler kept ONLY for post-construction writes (e.g. `data.age = 11` re-running the
  // pipeline). Initial construction goes through #applyKey directly to skip trap overhead.
  #operation = {
    set: (target, prop, startValue) => {
      this.#applyKey(target, prop, startValue);
      return true;
    },
  };

  constructor(config = {}) {
    this.config(config);
  }

  config(config = {}) {
    Object.assign(this.#config, config);
    return this;
  }

  args(args = {}) {
    Object.assign(this.#config.args, args);
    return this;
  }

  clone(config) {
    return new Transformer({ ...this.#config }).config(config);
  }

  transform(mixed, args = {}) {
    args.thunks ??= [];
    this.#callArgs = { ...this.#config.args, ...args };
    const { defaults } = this.#config;

    const transformed = Util.map(mixed, (data) => {
      const target = Object.defineProperties({}, {
        $thunks: { value: args.thunks },
        $userProvided: { value: Util.isPlainObject(data) ? data : {} },
      });

      const $data = Object.assign({}, defaults, data); // eslint-disable-line

      // Direct loop instead of Object.assign(new Proxy(...), $data) — avoids the trap
      // round-trip per key. Same semantics as the Proxy.set trap (see #applyKey).
      const keys = Object.keys($data);
      for (let i = 0; i < keys.length; i++) this.#applyKey(target, keys[i], $data[keys[i]]);

      // Proxy retained on the *result* so post-transform writes still re-fire pipelines.
      return new Proxy(target, this.#operation);
    });

    return this.#config.postTransform?.(transformed) || transformed;
  }

  // Single key transform — used both during construction (fast path) and from the Proxy.set
  // trap (post-construction writes). Mirrors the original reducer-in-trap semantics:
  //   - functions: pipeline-style reduce, undefined keeps previous value (Util.uvl)
  //   - strings: rename the target key
  //   - Promise result: store previous value, push promise to $thunks
  //   - skip writes of `undefined` unless user originally provided the key or keepUndefined
  //   - unknown keys: passthrough unless strictSchema
  #applyKey(target, prop, startValue) {
    const pipe = this.#config.shape[prop];

    if (pipe) {
      let value = startValue;
      let previousValue = startValue;
      const callArgs = this.#callArgs;
      let bag; // shared across this FIELD's argsSafe steps; retentive/unknown steps get a fresh spread
      for (let i = 0; i < pipe.length; i++) {
        const t = pipe[i];
        previousValue = value;
        if (typeof t === 'function') {
          let r;
          if (t.argsSafe) {
            bag ??= { startValue, value, ...callArgs };
            bag.value = value;
            r = t(bag);
          } else {
            r = t({ startValue, value, ...callArgs });
          }
          if (r !== undefined) value = r;
        } else {
          prop = t; // rename key
        }
      }

      if (value instanceof Promise) {
        target[prop] = previousValue;
        target.$thunks.push(value);
      } else if (value !== undefined || prop in target.$userProvided || this.#config.keepUndefined) {
        target[prop] = value;
      }
    } else if (!this.#config.strictSchema) {
      target[prop] = startValue;
    }
  }
};
