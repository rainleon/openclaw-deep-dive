import {
  __commonJS
} from "./chunk-BUSYA2B4.js";

// node_modules/ms/index.js
var require_ms = __commonJS({
  "node_modules/ms/index.js"(exports, module) {
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var y = d * 365.25;
    module.exports = function(val, options) {
      options = options || {};
      if ("string" == typeof val) return parse(val);
      return options.long ? long(val) : short(val);
    };
    function parse(str) {
      str = "" + str;
      if (str.length > 1e4) return;
      var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(str);
      if (!match) return;
      var n = parseFloat(match[1]);
      var type = (match[2] || "ms").toLowerCase();
      switch (type) {
        case "years":
        case "year":
        case "yrs":
        case "yr":
        case "y":
          return n * y;
        case "days":
        case "day":
        case "d":
          return n * d;
        case "hours":
        case "hour":
        case "hrs":
        case "hr":
        case "h":
          return n * h;
        case "minutes":
        case "minute":
        case "mins":
        case "min":
        case "m":
          return n * m;
        case "seconds":
        case "second":
        case "secs":
        case "sec":
        case "s":
          return n * s;
        case "milliseconds":
        case "millisecond":
        case "msecs":
        case "msec":
        case "ms":
          return n;
      }
    }
    function short(ms) {
      if (ms >= d) return Math.round(ms / d) + "d";
      if (ms >= h) return Math.round(ms / h) + "h";
      if (ms >= m) return Math.round(ms / m) + "m";
      if (ms >= s) return Math.round(ms / s) + "s";
      return ms + "ms";
    }
    function long(ms) {
      return plural(ms, d, "day") || plural(ms, h, "hour") || plural(ms, m, "minute") || plural(ms, s, "second") || ms + " ms";
    }
    function plural(ms, n, name) {
      if (ms < n) return;
      if (ms < n * 1.5) return Math.floor(ms / n) + " " + name;
      return Math.ceil(ms / n) + " " + name + "s";
    }
  }
});

// node_modules/debug/debug.js
var require_debug = __commonJS({
  "node_modules/debug/debug.js"(exports, module) {
    exports = module.exports = debug;
    exports.coerce = coerce;
    exports.disable = disable;
    exports.enable = enable;
    exports.enabled = enabled;
    exports.humanize = require_ms();
    exports.names = [];
    exports.skips = [];
    exports.formatters = {};
    var prevColor = 0;
    var prevTime;
    function selectColor() {
      return exports.colors[prevColor++ % exports.colors.length];
    }
    function debug(namespace) {
      function disabled() {
      }
      disabled.enabled = false;
      function enabled2() {
        var self = enabled2;
        var curr = +/* @__PURE__ */ new Date();
        var ms = curr - (prevTime || curr);
        self.diff = ms;
        self.prev = prevTime;
        self.curr = curr;
        prevTime = curr;
        if (null == self.useColors) self.useColors = exports.useColors();
        if (null == self.color && self.useColors) self.color = selectColor();
        var args = Array.prototype.slice.call(arguments);
        args[0] = exports.coerce(args[0]);
        if ("string" !== typeof args[0]) {
          args = ["%o"].concat(args);
        }
        var index = 0;
        args[0] = args[0].replace(/%([a-z%])/g, function(match, format) {
          if (match === "%%") return match;
          index++;
          var formatter = exports.formatters[format];
          if ("function" === typeof formatter) {
            var val = args[index];
            match = formatter.call(self, val);
            args.splice(index, 1);
            index--;
          }
          return match;
        });
        if ("function" === typeof exports.formatArgs) {
          args = exports.formatArgs.apply(self, args);
        }
        var logFn = enabled2.log || exports.log || console.log.bind(console);
        logFn.apply(self, args);
      }
      enabled2.enabled = true;
      var fn = exports.enabled(namespace) ? enabled2 : disabled;
      fn.namespace = namespace;
      return fn;
    }
    function enable(namespaces) {
      exports.save(namespaces);
      var split = (namespaces || "").split(/[\s,]+/);
      var len = split.length;
      for (var i = 0; i < len; i++) {
        if (!split[i]) continue;
        namespaces = split[i].replace(/\*/g, ".*?");
        if (namespaces[0] === "-") {
          exports.skips.push(new RegExp("^" + namespaces.substr(1) + "$"));
        } else {
          exports.names.push(new RegExp("^" + namespaces + "$"));
        }
      }
    }
    function disable() {
      exports.enable("");
    }
    function enabled(name) {
      var i, len;
      for (i = 0, len = exports.skips.length; i < len; i++) {
        if (exports.skips[i].test(name)) {
          return false;
        }
      }
      for (i = 0, len = exports.names.length; i < len; i++) {
        if (exports.names[i].test(name)) {
          return true;
        }
      }
      return false;
    }
    function coerce(val) {
      if (val instanceof Error) return val.stack || val.message;
      return val;
    }
  }
});

// node_modules/debug/browser.js
var require_browser = __commonJS({
  "node_modules/debug/browser.js"(exports, module) {
    exports = module.exports = require_debug();
    exports.log = log;
    exports.formatArgs = formatArgs;
    exports.save = save;
    exports.load = load;
    exports.useColors = useColors;
    exports.storage = "undefined" != typeof chrome && "undefined" != typeof chrome.storage ? chrome.storage.local : localstorage();
    exports.colors = [
      "lightseagreen",
      "forestgreen",
      "goldenrod",
      "dodgerblue",
      "darkorchid",
      "crimson"
    ];
    function useColors() {
      return "WebkitAppearance" in document.documentElement.style || // is firebug? http://stackoverflow.com/a/398120/376773
      window.console && (console.firebug || console.exception && console.table) || // is firefox >= v31?
      // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
      navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31;
    }
    exports.formatters.j = function(v) {
      return JSON.stringify(v);
    };
    function formatArgs() {
      var args = arguments;
      var useColors2 = this.useColors;
      args[0] = (useColors2 ? "%c" : "") + this.namespace + (useColors2 ? " %c" : " ") + args[0] + (useColors2 ? "%c " : " ") + "+" + exports.humanize(this.diff);
      if (!useColors2) return args;
      var c = "color: " + this.color;
      args = [args[0], c, "color: inherit"].concat(Array.prototype.slice.call(args, 1));
      var index = 0;
      var lastC = 0;
      args[0].replace(/%[a-z%]/g, function(match) {
        if ("%%" === match) return;
        index++;
        if ("%c" === match) {
          lastC = index;
        }
      });
      args.splice(lastC, 0, c);
      return args;
    }
    function log() {
      return "object" === typeof console && console.log && Function.prototype.apply.call(console.log, console, arguments);
    }
    function save(namespaces) {
      try {
        if (null == namespaces) {
          exports.storage.removeItem("debug");
        } else {
          exports.storage.debug = namespaces;
        }
      } catch (e) {
      }
    }
    function load() {
      var r;
      try {
        r = exports.storage.debug;
      } catch (e) {
      }
      return r;
    }
    exports.enable(load());
    function localstorage() {
      try {
        return window.localStorage;
      } catch (e) {
      }
    }
  }
});
export default require_browser();
//# sourceMappingURL=debug.js.map
