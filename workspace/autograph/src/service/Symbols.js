// Symbol-keyed slots used internally on plain event/result objects. Symbol keys are skipped
// by spread, Object.keys, JSON.stringify, and for-in loops — same hygiene as non-enumerable
// properties via defineProperty, but cheaper: included in the initial object literal, the
// V8 hidden class stays stable instead of mutating when a defineProperty is added later.

exports.$QUERY = Symbol('autograph.$query');
