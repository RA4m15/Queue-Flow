'use strict';

const { validationResult } = require('express-validator');
const { sendBadRequest } = require('../utils/apiResponse');

const MONGO_ID_REGEX = /^[a-fA-F0-9]{24}$/;

/**
 * Middleware: check express-validator results and return 400 if any errors.
 * Place this after your validation chain in route definitions.
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendBadRequest(
      res,
      'Validation failed',
      errors.array().map((e) => ({ field: e.path, message: e.msg }))
    );
  }
  next();
}

/**
 * Middleware factory: validate that specified route params are valid 24-hex MongoDB ObjectIds.
 * Returns HTTP 400 if any specified param is malformed, preventing CastErrors and injection.
 *
 * @param {...string} paramNames - Parameter names to validate (e.g. 'id', 'centerId', 'serviceId')
 */
function validateObjectId(...paramNames) {
  const targets = paramNames.length > 0 ? paramNames : ['id'];
  return (req, res, next) => {
    for (const name of targets) {
      const val = req.params[name];
      if (val !== undefined) {
        if (typeof val !== 'string' || !MONGO_ID_REGEX.test(val)) {
          return sendBadRequest(res, `Invalid ID format for parameter '${name}'`);
        }
      }
    }
    next();
  };
}

/**
 * Deep check for keys starting with '$' or containing '.' in objects/arrays.
 * Returns true if any prohibited MongoDB operator or path key is found.
 */
function _hasProhibitedKeys(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) {
    return obj.some((item) => _hasProhibitedKeys(item));
  }
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      return true;
    }
    if (typeof obj[key] === 'object' && _hasProhibitedKeys(obj[key])) {
      return true;
    }
  }
  return false;
}

/**
 * Global middleware: recursively scans req.body, req.query, and req.params
 * and rejects any payload containing MongoDB query operator keys ('$' prefix) or dots.
 * Returns HTTP 400 if prohibited structures are detected.
 */
function sanitizeNoSql(req, res, next) {
  if (_hasProhibitedKeys(req.body)) {
    return sendBadRequest(res, 'Prohibited operator in request body');
  }
  if (_hasProhibitedKeys(req.query)) {
    return sendBadRequest(res, 'Prohibited operator in query string');
  }
  if (_hasProhibitedKeys(req.params)) {
    return sendBadRequest(res, 'Prohibited operator in path parameters');
  }
  next();
}

/**
 * Global middleware: handles HTTP Parameter Pollution (HPP).
 * If query parameters that expect single values are duplicated into arrays (e.g. ?limit=10&limit=999),
 * this retains the last value to prevent crashes (such as .toUpperCase() on an array).
 */
function preventParameterPollution(req, _res, next) {
  if (req.query && typeof req.query === 'object') {
    for (const key of Object.keys(req.query)) {
      if (Array.isArray(req.query[key])) {
        // Retain the last scalar occurrence
        req.query[key] = req.query[key][req.query[key].length - 1];
      }
    }
  }
  next();
}

validate.validate = validate;
validate.validateObjectId = validateObjectId;
validate.sanitizeNoSql = sanitizeNoSql;
validate.preventParameterPollution = preventParameterPollution;
validate.MONGO_ID_REGEX = MONGO_ID_REGEX;

module.exports = validate;

