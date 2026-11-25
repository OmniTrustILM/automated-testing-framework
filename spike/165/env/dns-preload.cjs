// Resolves the throw-away edge's host name to the kind port mapping on loopback (no /etc/hosts change needed).
const dns = require('dns');
const orig = dns.lookup;
dns.lookup = function (host, opts, cb) {
  if (host === 'ilm.kind.local') {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    return opts && opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4);
  }
  return orig.apply(this, arguments);
};
const origP = dns.promises.lookup;
dns.promises.lookup = function (host, opts) {
  if (host === 'ilm.kind.local') {
    return Promise.resolve(opts && opts.all ? [{ address: '127.0.0.1', family: 4 }] : { address: '127.0.0.1', family: 4 });
  }
  return origP.apply(this, arguments);
};
