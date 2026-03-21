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

  #operation = {
    set: (target, prop, startValue, proxy) => {
      if (this.#config.shape[prop]) {
        let previousValue;

        const result = this.#config.shape[prop].reduce((value, t) => {
          previousValue = value;
          if (typeof t === 'function') return Util.uvl(t({ startValue, value, ...this.#callArgs }), value);
          prop = t; // rename key
          return value;
        }, startValue);

        if (result instanceof Promise) {
          target[prop] = previousValue;
          proxy.$thunks.push(result);
        } else if (result !== undefined || this.#config.keepUndefined) {
          target[prop] = result;
        }
      } else if (!this.#config.strictSchema) {
        target[prop] = startValue;
      }

      return true;
    },
  };

  /**
   * Allowing construction of object before knowing full configuration
   */
  constructor(config = {}) {
    this.config(config);
  }

  /**
   * Re-assign configuration after instantiation
   */
  config(config = {}) {
    Object.assign(this.#config, config);
    return this;
  }

  /**
   * Re-assign args after instantiation
   */
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

    const transformed = Util.map(mixed, (data) => {
      const thunks = Object.defineProperty({}, '$thunks', { value: args.thunks });
      const $data = Object.assign({}, this.#config.defaults, data); // eslint-disable-line
      return Object.assign(new Proxy(thunks, this.#operation), $data);
    });

    return this.#config.postTransform?.(transformed) || transformed;
  }
};
