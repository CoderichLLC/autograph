module.exports = class PostgresDriver {
  #config; #client; #connection;

  constructor(config = {}) {
    this.#config = config;
    this.#config.query = config.query || {};
    this.#client = new MongoClient(config.uri, config.options);
    // this.#connection = this.#mongoClient.connect();
  }
};
