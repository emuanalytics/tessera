#!/usr/bin/env node
"use strict";

// increase the libuv threadpool size to 1.5x the number of logical CPUs.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || Math.ceil(Math.max(4, require('os').cpus().length * 1.5));

var fs = require("fs"),
    path = require("path");

var cors = require("cors"),
    debug = require("debug"),
    express = require("express"),
    morgan = require("morgan"),
    responseTime = require("response-time"),
    lru = require("lru-cache"),
    handlebars = require("handlebars"),
    sqlstring = require("sqlstring"),
    jwt = require('express-jwt'),
    cookieParser = require('cookie-parser');

var CACHE = lru(50);

var serve = require("./lib/app"),
    tessera = require("./lib/index");

debug = debug("tessera");

// Add morgan token 'id' that extracts user email from JWT or 'anon' if not authenticated
morgan.token('id', function getId (req) {
  return req.user && req.user.email || 'anon';
});

handlebars.registerHelper('sqlEscape', function(str) {
  return new handlebars.SafeString(sqlstring.escape(str));
});

module.exports = function(opts, callback) {
  var app = express().disable("x-powered-by"),
      tilelive = require("tilelive-cache")(require("@mapbox/tilelive"), {
        size: process.env.CACHE_SIZE || opts.cacheSize,
        sources: process.env.SOURCE_CACHE_SIZE || opts.sourceCacheSize
      });

  callback = callback || function() {};

  // load and register tilelive modules
  require("tilelive-modules/loader")(tilelive, opts);

  if (process.env.NODE_ENV === "production") {
    app.use(morgan(":remote-addr - :id [:date[clf]] \":method :url HTTP/:http-version\" :status :res[content-length] - :response-time ms"));
  }
  else {
    // TODO configurable logging per-style
    app.use(morgan("dev"));
  }

  if (opts.jwtSecret) {
    app.use(cookieParser());
    app.use(jwt({
      secret: opts.jwtSecret,
      getToken: function fromRequest (req) {
        if (req.headers.authorization && req.headers.authorization.split(' ')[0] === 'Bearer') {
          return req.headers.authorization.split(' ')[1];
        } else if (req.query && req.query.token) {
          return req.query.token;
        } else if (req.cookies && req.cookies.token) {
          return req.cookies.token;
        }
        return null;
      }
    }));
    app.use(function (err, req, res, next) {
      if (err.name === 'UnauthorizedError') {
        res.status(401).send('Invalid token');
      }
    });
  }

  if (opts.uri) {
    app.use(responseTime());
    app.use(cors());
    app.use(express.static(path.join(__dirname, "public")));
    app.use(express.static(path.join(__dirname, "bower_components")));
    app.use(serve(tilelive, opts.uri));

    tilelive.load(opts.uri, function(err, src) {
      if (err) {
        throw err;
      }

      return tessera.getInfo(src, function(err, info) {
        if (err) {
          debug(err.stack);
          return;
        }

        if (info.format === "pbf") {
          app.use("/_", serve(tilelive, "xray+" + opts.uri));
          app.use("/_", express.static(path.join(__dirname, "public")));
          app.use("/_", express.static(path.join(__dirname, "bower_components")));
        }
      });
    });
  }

  if (opts.config) {
    var configPath = path.resolve(opts.config),
        stats = fs.statSync(configPath),
        config = {};

    if (stats.isFile()) {
      config = require(configPath);
    } else if (stats.isDirectory()) {
      config = fs.readdirSync(configPath)
        .filter(function(filename) {
          return path.extname(filename) === ".json";
        })
        .reduce(function(config, filename) {
          var localConfig = require(path.join(configPath, filename));

          return Object.keys(localConfig).reduce(function(config, k) {
            config[k] = localConfig[k];

            return config;
          }, config);
        }, config);
    }

    Object.keys(config).forEach(function(prefix) {

      // config[prefix] is a string
      var source = config[prefix];

      if (source.source) {
        // actually, it's an object
        source = source.source;
      }

      var sourceTemplate = handlebars.compile(source);

      if (config[prefix].timing !== false) {
        app.use(prefix, responseTime());
      }

      if (config[prefix].cors !== false) {
        app.use(prefix, cors());
      }

      app.use(prefix, express.static(path.join(__dirname, "public")));
      app.use(prefix, express.static(path.join(__dirname, "bower_components")));

      app.use(prefix, function(req, res, next) {

        var key = prefix + ',' + Object.keys(req.query).sort().map(function(key) {return key + '=' + req.query[key];});
        var route;

        if (!(route = CACHE.get(key))) {
          var interpolatedSource = sourceTemplate(Object.assign({}, config[prefix].defaultParams, req.query));
          debug('Caching route: ' + key);
          debug('Interpolated source:' + interpolatedSource);
          var patchedConfig = Object.assign({}, config[prefix], {source: interpolatedSource});
          route = serve(tilelive, patchedConfig);
          CACHE.set(key, route);
        }

        return route(req, res, next);
      });

      // defaultParams are used for xray
      var xraySource = sourceTemplate(config[prefix].defaultParams);
      tilelive.load(xraySource, function(err, src) {
        if (err) {
          throw err;
        }

        return tessera.getInfo(src, function(err, info) {

          if (err) {
            debug(err.stack);
            return;
          }

          if (info.format === "pbf") {
            app.use(prefix + "/_", serve(tilelive, "xray+" + xraySource));
            app.use(prefix + "/_", express.static(path.join(__dirname, "public")));
            app.use(prefix + "/_", express.static(path.join(__dirname, "bower_components")));
          }
        });
      });
    });
  }

  var handler = process.env.SOCKET || opts.socket || process.env.PORT || opts.port;
  var server = app.listen(handler, process.env.HOST || opts.bind, function() {
    var endpoint;
    if (opts.socket) {
      endpoint = opts.socket;

      // allow the socket to be accessed by other users/groups
      fs.chmodSync(opts.socket, "1766");
    } else if (process.env.SOCKET) {
      endpoint = process.env.SOCKET;

      // allow the socket to be accessed by other users/groups
      fs.chmodSync(opts.socket, "1766");
    } else {
      endpoint = "http://" + this.address().address + ':' + this.address().port;
    }
    console.log("Listening at %s", endpoint);

    return callback();
  });

  process.on('SIGINT', function () {
    console.warn('Caught SIGINT, terminating');
    server.close();
    process.exit();
  });
};
