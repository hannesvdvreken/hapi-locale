/*jslint node: true, nomen: true, stupid: true */
/**
 * @module 'hapi-locale'
 * @description
 * Plugin module to use in hapi.js applications to determine requested language.
 */

var Boom        = require('boom'),
    fs          = require('fs'),
    path        = require('path'),
    lodash      = require('lodash');

var rootDir     = path.join(__dirname, '../../..');
var locales     = [];

/**
 * @typedef {Object}                    PluginOptions                   - Plugin configuration options.
 * @property {Array.<string>}           locales                         - List of locales to use in application.
 * @property {string}                   [default=1st Locale]            - Default locale to use if no locale is given.
 * @property {string}                   [configFile=package.json]       - Configuration file to get available locales.
 * @property {string}                   [configKey=locales]             - Key to look in configuration file to get available locales. May be nested key such as 'a.b.c'.
 * @property {Object}                   [scan]                          - Scanning options to get available locales
 * @property {string}                   [scan.path=locale]              - Path or paths to scan locale files to get available locales.
 * @property {string}                   [scan.fileTypes=json]           - File types to scan. ie. "json" for en_US.json, tr_TR.json
 * @property {boolean}                  [scan.directories=true]         - whether to scan directory names to get available locales.
 * @property {Array.<string>}           [scan.exclude=[templates]]      - Directory or file names to exclude from scan results.
 * @property {Object}                   [nameOf]                        - Name of the parameters to determine language.
 * @property {string}                   [nameOf.param=lang]             - Name of the path parameter to determine language. ie. /{lang}/account
 * @property {string}                   [nameOf.query=lang]             - Name of the query parameter to determine language. ie. /account?lang=tr_TR
 * @property {string}                   [nameOf.cookie=lang]            - Name of the cookie to determine language.
 * @property {string}                   [nameOf.cookieKey=lang]         - Name of the key to look inside cookie to determine language. May be nested key such as 'a.b.c'.
 * @property {Object}                   [nameOf.header=accept-language] - Name of the header parameter to determine language.
 * @property {Array.<string>}           [order=['params', 'cookie', 'query', 'headers']] - Order in which language determination process follows. First successful method returns requested language.
 * @property {boolean}                  [throw404]                      - Whether to throw 404 not found if locale is not found. Does not apply path parameters, it always throws 404.
 * @property {Function|string}          [getter=getLocale]      - Getter method to get current locale. May be nested path such as 'a.b.c'.
 * @property {Function|string}          [setter=setLocale]      - Setter method to set current locale. May be nested path such as 'a.b.c'.
 * @property (boolean)                  [createAccessorsIfNotExists=true] - Creates getter and setter if they do not exist. To be created they must be given as string.
 * @property {Function|string}          [callback=setLocale]            - Callback method to set locale. If given as function called directly. If given as string called as a method of request object. May be nested path such as 'a.b.c'.
 * @property {string}                   [onEvent=onPreAuth]             - Event on which locale determination process is fired.
 */

/**
 * @type {PluginOptions}
 * @private
 */
var defaultOptions = {
    locales             : [],
    default             : null,
    configFile          : path.join(rootDir, 'package.json'),
    configKey           : 'locales',
    scan                : {
        path        : path.join(rootDir, 'locales'),
        fileType    : 'json',
        directories : true,
        exclude     : ['templates', 'template.json']
    },
    nameOf              : {
        param       : 'lang',
        query       : 'lang',
        cookie      : 'lang',
        cookieKey   : 'lang',
        header      : 'accept-language'
    },
    order           : ['params', 'cookie', 'query', 'headers'],
    throw404        : false,
    getter          : 'i18n.getLocale',
    setter          : 'i18n.setLocale',
    createAccessorsIfNotExists: true,
    callback            : 'i18n.setLocale',
    onEvent             : 'onPreAuth'
};

var orderParameters = {
    //method   request   options.nameOf
    params  : ['params', 'param'],
    query   : ['query', 'query'],
    headers : ['headers', 'header'],
    cookie  : ['state', 'cookie', 'cookieKey']
};

/**
 * Checks requirements:
 * - Checks if scan path is available.
 * - Checks if config file is available.
 * - Checks existence of language JSON files.
 * - Checks if some locales are available.
 * @param {PluginOptions} options    - Plugin configuration options.
 * @returns {undefined|string}       - Error string or undefined if no errors are found.
 * @private
 */
function checkRequirements(options) {
    "use strict";
    var i;

    for (i = 0; i < options.order.length; i = i + 1) {
        if (!orderParameters[options.order[i]]) {
            return options.order[i] + ' from "options.order" is not one of the allowed methods for language determination.';
        }
    }

    if (Array.isArray(options.locales) && options.locales.length > 0) {
        return;     // No need to check files, because no config file or scanning are necessary.
    }

    if (options.scan.path && !exists(options.scan.path, true)) {    // Check if scan path is available
        return 'Locales directory "' + options.scan.path + '"cannot be found.';
    }

    if (options.configFile && !exists(options.configFile, false)) { // Check if config file is available
        return 'Configuration file "' + options.configFile + '" cannot be found';
    }

    // Check existence of language JSON files.
    for (i=0; i<options.locales.length; i=i+1) {
        if (!exists(path.join(options.directory, options.locales[i] + '.json'), false)) {
            return 'Locale file "' + path.join(options.directory, options.locales[i] + '.json') + '" cannot be found';
        }
    }

    options.locales = getAvailableLocales(options);

    if (!options.locales || options.locales.length === 0) {
        return 'No locales found.';
    }
}


/**
 * Scans path in options.scan.path and returns list of available locale files.
 * @property {Object}                   [scan]                          - Scanning options to get available locales
 * @property {string}                   [scan.path=locale]              - Path or paths to scan locale files to get available locales.
 * @property {string}                   [scan.fileTypes=json]           - File types to scan. ie. "json" for en_US.json, tr_TR.json
 * @property {boolean}                  [scan.directories=true]         - whether to scan directory names to get available locales.
 * @property {Array.<string>}           [scan.exclude=[templates]]      - Directory or file names to exclude from scan results.
 * @returns {Array.<string>}
 * @private
 */
function scan(options) {
    "use strict";
    var i,
        fullPath,
        locales = [],
        dir     = options.path,
        files   = fs.readdirSync(dir);

    for (i = 0; i < files.length; i = i + 1) {
        fullPath = path.join(dir, files[i]);

        // Skip if it is in exclude list or it is directory and scan.directories is false
        if (options.exclude.indexOf(files[i]) > -1 || (fs.statSync(fullPath).isDirectory() && !options.directories)) {
            continue;
        }

        locales.push(path.basename(files[i], '.' + options.fileType));
    }

    return lodash.unique(locales);
}



/**
 * Determines which locales are available. It tries to determine available locales in given order:
 * 1. Returns if locales are present in options.locales.
 * 2. If not found, looks for given config file and searches opted key in config file.
 * 3. If not found, scans path given in options.scan.path for files and directories excluding files in options.scan.exclude.
 * @param {PluginOptions}   options
 * @returns {Array|null}    - List of available locales
 * @private
 */
function getAvailableLocales(options) {
    "use strict";
    var locales = [];

    if (Array.isArray(options.locales) && options.locales.length > 0) {
        return options.locales;     // No need to check files, because no config file or scanning are necessary.
    }

    if (locales.length === 0 && options.configFile) {
        locales = lodash.get(require(options.configFile), options.configKey);       // key chain string to reference: 'options.locale' => options.locale
        if (!Array.isArray(locales)) { locales = []; }
    }

    if (locales.length === 0 && options.scan.path) {
        locales = scan(options.scan);
    }

    return locales.length > 0 ? locales : null;
}



/**
 * Checks synchroniously if given file or directory exists. Returns true or false.
 * @param {string}  path        - Path of the file or directory.
 * @param {boolean} shouldBeDir - Whether given path should be directory.
 * @returns {boolean}
 * @private
 */
function exists(path, shouldBeDir) {
    "use strict";
    try {
        var lstat = fs.lstatSync(path);
        if (shouldBeDir && lstat.isDirectory()) { return true; }
        if (!shouldBeDir && lstat.isFile()) { return true; }
    } catch(err) {
        return false;
    }
    return false;
}



/**
 * Converts options.order into key chains to access in request object and returns it.
 * For example cookie : ['state', 'cookie', 'cookieKey'] becomes state[options.nameOf.cookie][options.nameOf.cookieKey] such as "state.lang.lang" to access necessary cookie.
 * @param   {Object} options    - Plugin options
 * @returns {Array}             - Key chains to access in order to determine language.
 * @private
 */
function getOrderedKeyChain(options) {
    "use strict";
    var i,
        methodDetails,
        order = [];

    for (i = 0; i < options.order.length; i = i + 1) {
        methodDetails = orderParameters[options.order[i]];

        // request.params[name] | request.query[name] | request.headers[name] | request.state[name][name]
        order.push(methodDetails[0] + '.' + methodDetails.slice(1).map(function(val) {
                return options.nameOf[val];
            }).join('.'));
    }

    return order;
}

/**
 * @param {Object}              request - hapi.js request object
 * @param {PluginOptions}       options - Plugin configuration options.
 * @returns {Array.<string>}            - List of requested locales in order of preference.
 * @private
 */
function getRequestedLocales(request, options) {
    "use strict";
    var i,
        requestedLocales;

    for (i = 0; i < options.order.length; i = i + 1) {
        requestedLocales = lodash.get(request, options.order[i]);
        if (requestedLocales) {
            // Header and Query parameter may return array of languages in preferred order.
            return {
                source: options.order[i],
                locales: Array.isArray(requestedLocales) ? requestedLocales : [requestedLocales]
            };
        }
    }
    return {
        source: '',
        locales: []
    };
}

/**
 * @param {Object}              request - hapi.js request object
 * @param {Object}              reply   - hapi.js reply object
 * @param {PluginOptions}       options - Plugin configuration options.
 * @returns {string|undefined}          - Locale
 * @private
 */
function determineLocale(request, reply, options) {
    var i,
        requestedLocales = getRequestedLocales(request, options);

    for (i = 0; i < requestedLocales.locales.length; i = i + 1) {
        if (options.locales.indexOf(requestedLocales.locales[i]) > -1) {
            return requestedLocales.locales[i]
        }
    }

    // If none of the requested locales are available: For wrong path params and throw404 option throw 404.
    if (requestedLocales.source.indexOf('params') === 0 || options.throw404) {
        return reply( Boom.notFound('Requested localization "' + getRequestedLocales(request, options) + '" is not available.') );
    }

    return options.default;
}







/**
 *
 * @param {Object}              request - hapi.js request object
 * @param {Object}              reply   - hapi.js reply object
 * @param {PluginOptions}       options - Plugin configuration options.
 * @returns {*}
 * @private
 */
function processRequest(options, request, reply) {
    "use strict";
    var locale = determineLocale(request, reply, options);

    // Add getter to request if necessary.
    if (typeof options.getter === 'string' && options.getter !== '' && options.createAccessorsIfNotExists && !lodash.has(request, options.getter)) {
        lodash.set(request, options.getter, function() {
            return locale;
        });
    }

    // Add setter to request if necessary.
    if (typeof options.setter === 'string' && options.setter !== '' && options.createAccessorsIfNotExists && !lodash.has(request, options.setter)) {
        lodash.set(request, options.setter, function() {
            return locale;
        });
    }

    // Call callback function
    if (typeof options.callback === 'function') {
        options.callback(locale);
    } else if (typeof options.callback === 'string' && options.callback !== '') {
        lodash.get(request, options.callback)(locale);
    }

    return reply.continue();
}



/**
 * Hapi plugin function which adds i18n support to request and response objects.
 * @param {Object}          server      - Hapi server object
 * @param {PluginOptions}   options     - Plugin configuration options.
 * @param {Function}        next        - Callback function.
 */
exports.register = function(server, options, next) {
    "use strict";
    var error;
    lodash.defaultsDeep(options, defaultOptions);
    error = checkRequirements(options);

    if (error) {
        return next(new Error(error));
    }

    options.default = options.default || options.locales[0];
    options.order   = getOrderedKeyChain(options);

    /**
     * @module exposed
     * @description
     * Exposed functions and attributes are listed under exposed name.
     * To access those attributes `request.server.plugins['hapi-locale']` can be used.
     * @example
     * var locales = request.server.plugins['hapi-locale'].getLocales(); // ['tr_TR', 'en_US'] etc.
     */

    /**
     * Returns all available locales as an array.
     * @name getLocales
     * @function
     * @returns {Array.<string>}    - Array of locales.
     * @example
     * var locales = request.server.plugins['hapi-locale'].getLocales(); // ['tr_TR', 'en_US'] etc.
     */
    server.expose('getLocales', function getLocales() { return options.locales; } );

    /**
     * Returns default locale.
     * @name getDefaultLocale
     * @function
     * @returns {string}    - Default locale
     */
    server.expose('getDefaultLocale', function getDefaultLocale() { return options.default; } );

    /**
     * Returns requested language. Can be used if developer does not want to pollute request object and want to get locale manually.
     * If no getLocale or similar method is available on request object, it may be best interest to store result elsewhere and use it during request's life instead of calling this function repetitively to prevent repeated calculations.
     * If getMethod or similar method is available and set via `options.getter` this function uses it.
     * @name getLocale
     * @function
     * @param {Object}      request - Hapi.js request object
     * @param {Object}      reply   - Hapi.js reply object
     * @returns {string}    Locale
     */
    server.expose('getLocale', function getLocale(request, reply) {
        return options.getter ? lodash.get(request, options.getter)() : determineLocale(request, reply, options);
    });

    server.ext(options.onEvent, processRequest.bind(undefined, options)); //function(request, reply) { return processRequest(request, reply, options) } );

    return next();
};

exports.register.attributes = {
    pkg: require('./../package.json')
};