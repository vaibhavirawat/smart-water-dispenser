// One place that decides how to reach MySQL. Supports plain DB_* vars, a connection URL
// (DATABASE_URL / MYSQL_URL) and the MYSQL* vars that hosts like Railway provide.
function dbConfig() {
  const e = process.env;
  const url = e.DATABASE_URL || e.MYSQL_URL;
  let c;
  if (url) {
    const u = new URL(url);
    c = {
      host: u.hostname, port: +(u.port || 3306), user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database: u.pathname.slice(1) || e.DB_NAME || 'smart_water',
    };
  } else {
    c = {
      host: e.DB_HOST || e.MYSQLHOST || 'localhost',
      port: +(e.DB_PORT || e.MYSQLPORT || 3306),
      user: e.DB_USER || e.MYSQLUSER || 'root',
      password: e.DB_PASSWORD ?? e.MYSQLPASSWORD ?? '',
      database: e.DB_NAME || e.MYSQLDATABASE || 'smart_water',
    };
  }
  if (!/^\w+$/.test(c.database)) throw new Error('Database name may only contain letters, numbers and underscores');
  if (e.DB_SSL === 'true') c.ssl = { rejectUnauthorized: e.DB_SSL_REJECT_UNAUTHORIZED !== 'false' };
  return c;
}
module.exports = { dbConfig };
