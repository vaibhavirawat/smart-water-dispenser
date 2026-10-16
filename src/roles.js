// Account roles. 'viewer' is what the UI calls a "user": anyone who signs up, can look at dispensers and raise complaints.
const ROLES = ['admin', 'caretaker', 'technician', 'viewer'];
const isRole = r => ROLES.includes(r);
module.exports = { ROLES, isRole };
