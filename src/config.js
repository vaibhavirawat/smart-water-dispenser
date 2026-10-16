// Runtime settings read from the environment (dotenv is loaded by server.js before this is required).
const env = process.env;

module.exports = {
  PORT: +(env.PORT || 3000),
  OFFLINE_AFTER_MIN: +(env.OFFLINE_AFTER_MIN || 2),
  LOW_LEVEL_PCT: +(env.LOW_LEVEL_PCT || 20), // default; a dispenser can override it
  HIGH_TEMP_C: +(env.HIGH_TEMP_C || 25), // default; a dispenser can override it
  signupEnabled: () => (env.ALLOW_SIGNUP ?? 'true').toLowerCase() !== 'false',
};
