const KeyvRedis = require('@keyv/redis');
const { isEnabled } = require('~/server/utils');
const logger = require('~/config/winston');
const fs = require('fs');
const ioredis = require('ioredis');

const { REDIS_URI, USE_REDIS, USE_REDIS_CLUSTER, REDIS_CA } = process.env;

let keyvRedis;

function mapURI(uri) {
  const regex =
    /^(?:(?<scheme>\w+):\/\/)?(?:(?<user>[^:@]+)(?::(?<password>[^@]+))?@)?(?<host>[\w.-]+)(?::(?<port>\d{1,5}))?$/;
  const match = uri.match(regex);

  if (match) {
    const { scheme, user, password, host, port } = match.groups;

    return {
      scheme: scheme || 'none',
      user: user || null,
      password: password || null,
      host: host || null,
      port: port || null,
    };
  } else {
    // Handle cases without a scheme
    const parts = uri.split(':');
    if (parts.length === 2) {
      return {
        scheme: 'none',
        user: null,
        password: null,
        host: parts[0],
        port: parts[1],
      };
    }

    return {
      scheme: 'none',
      user: null,
      password: null,
      host: uri,
      port: null,
    };
  }
}

if (REDIS_URI && isEnabled(USE_REDIS)) {
  let redisOptions = null;
  let keyvOpts = { useRedisSets: false };
  if (REDIS_CA) {
    const ca = fs.readFileSync(REDIS_CA);
    redisOptions = { tls: { ca } };
  }
  if (isEnabled(USE_REDIS_CLUSTER)) {
    const hosts = REDIS_URI.split(',').map((item) => {
      var value = mapURI(item);

      return {
        host: value.host,
        port: value.port
      };
    });
    const cluster = new ioredis.Cluster(hosts, { redisOptions });
    keyvRedis = new KeyvRedis(cluster, keyvOpts);
  } else {
    keyvRedis = new KeyvRedis(REDIS_URI, keyvOpts);
  }
  keyvRedis.on('error', (err) => logger.error('KeyvRedis connection error:', err));
  keyvRedis.setMaxListeners(0);
  logger.info(
    '[Optional] Redis initialized. Note: Redis support is experimental. If you have issues, disable it. Cache needs to be flushed for values to refresh.',
  );
} else {
  logger.info('[Optional] Redis not initialized. Note: Redis support is experimental.');
}

module.exports = keyvRedis;