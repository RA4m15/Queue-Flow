'use strict';

const { body } = require('express-validator');
const User = require('../models/User');
const Counter = require('../models/Counter');
const { signToken } = require('../middleware/auth');
const { disconnectUserSockets } = require('../config/socket');
const asyncHandler = require('../utils/asyncHandler');
const { logger } = require('../utils/logger');
const { maskEmail } = require('../utils/redact');
const {
  sendSuccess,
  sendCreated,
  sendBadRequest,
  sendUnauthorized,
  sendConflict,
} = require('../utils/apiResponse');

// ─── Validation rules ─────────────────────────────
const registerValidation = [
  body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Name must be 2–80 characters'),
  body('email').trim().isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain uppercase, lowercase, and a number'),
  body('phone').optional().isMobilePhone().withMessage('Invalid phone number'),
];

const loginValidation = [
  body('email').trim().isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
];

const changePasswordValidation = [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain uppercase, lowercase, and a number'),
];

const updateMeValidation = [
  body('name').optional().isString().trim().isLength({ min: 2, max: 80 }).withMessage('Name must be 2–80 characters'),
  body('phone').optional({ nullable: true }).isString().trim().isLength({ max: 20 }).withMessage('Phone must not exceed 20 characters'),
  body('fcmToken')
    .optional({ nullable: true })
    .custom((val) => {
      if (val === null || val === '') return true;
      if (typeof val !== 'string') {
        throw new Error('fcmToken must be a string or null');
      }
      const trimmed = val.trim();
      if (trimmed === '') return true;
      if (trimmed.length < 20 || trimmed.length > 500) {
        throw new Error('fcmToken must be between 20 and 500 characters');
      }
      if (!/^[a-zA-Z0-9_:\-+=/]+$/.test(trimmed)) {
        throw new Error('fcmToken contains invalid characters');
      }
      return true;
    }),
];

// ─── Controllers ──────────────────────────────────

/**
 * POST /api/auth/register
 * Register a new customer account.
 */
const register = asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;

  // Check if email already exists
  const existing = await User.findOne({ email });
  if (existing) {
    return sendConflict(res, 'An account with this email already exists');
  }

  const passwordHash = await User.hashPassword(password);

  const user = await User.create({
    name,
    email,
    phone: phone || undefined,
    passwordHash,
    role: 'CUSTOMER',
  });

  const token = signToken(user._id.toString(), user.role, user.tokenVersion || 0);

  return sendCreated(res, {
    message: 'Registration successful',
    data: {
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        preferences: user.preferences,
      },
    },
  });
});

/**
 * POST /api/auth/login
 * Authenticate a user and return a JWT.
 */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  // Fetch user including passwordHash (select: false by default)
  const user = await User.findOne({ email }).select('+passwordHash');
  if (!user) {
    logger.security('AUTH_LOGIN_FAILURE', {
      requestId: req.id,
      account: maskEmail(email),
      reason: 'user_not_found',
      clientIp: req.ip,
    });
    return sendUnauthorized(res, 'Invalid email or password');
  }

  if (!user.isActive) {
    logger.security('AUTH_LOGIN_FAILURE', {
      requestId: req.id,
      account: maskEmail(email),
      userId: user._id.toString(),
      reason: 'account_deactivated',
      clientIp: req.ip,
    });
    return sendUnauthorized(res, 'Your account has been deactivated');
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    logger.security('AUTH_LOGIN_FAILURE', {
      requestId: req.id,
      account: maskEmail(email),
      userId: user._id.toString(),
      reason: 'invalid_password',
      clientIp: req.ip,
    });
    return sendUnauthorized(res, 'Invalid email or password');
  }

  // Update last login time
  await User.findByIdAndUpdate(user._id, { lastLogin: new Date() });

  const token = signToken(user._id.toString(), user.role, user.tokenVersion || 0);

  logger.security('AUTH_LOGIN_SUCCESS', {
    requestId: req.id,
    userId: user._id.toString(),
    role: user.role,
    clientIp: req.ip,
  });

  let assignedCounter = null;
  if (user.role === 'STAFF') {
    assignedCounter = await Counter.findOne({ staffId: user._id })
      .populate('centerId', 'name code')
      .populate('serviceId', 'name tokenPrefix')
      .lean();
  }

  return sendSuccess(res, {
    message: 'Login successful',
    data: {
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        centerId: user.centerId || assignedCounter?.centerId?._id || null,
        assignedCounterId: user.assignedCounterId || assignedCounter?._id || null,
        assignedCounter: assignedCounter || null,
        preferences: user.preferences,
      },
    },
  });
});

/**
 * GET /api/auth/me
 * Return the currently authenticated user.
 * Requires: protect middleware
 */
const getMe = asyncHandler(async (req, res) => {
  let assignedCounter = null;
  if (req.user.role === 'STAFF') {
    assignedCounter = await Counter.findOne({ staffId: req.user._id })
      .populate('centerId', 'name code')
      .populate('serviceId', 'name tokenPrefix')
      .lean();
  }

  return sendSuccess(res, {
    data: {
      user: {
        _id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        phone: req.user.phone,
        role: req.user.role,
        centerId: req.user.centerId || assignedCounter?.centerId?._id || null,
        assignedCounterId: req.user.assignedCounterId || assignedCounter?._id || null,
        assignedCounter: assignedCounter || null,
        preferences: req.user.preferences,
        createdAt: req.user.createdAt,
        lastLogin: req.user.lastLogin,
      },
    },
  });
});

/**
 * PATCH /api/auth/me
 * Update profile (name, phone, preferences, fcmToken).
 */
const updateMe = asyncHandler(async (req, res) => {
  const allowedFields = ['name', 'phone', 'preferences', 'fcmToken'];
  const updates = {};

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  // Handle fcmToken reassignment / clearing
  if ('fcmToken' in updates) {
    const rawToken = updates.fcmToken;
    if (rawToken === null || (typeof rawToken === 'string' && rawToken.trim() === '')) {
      updates.fcmToken = null;
    } else if (typeof rawToken === 'string') {
      const cleanToken = rawToken.trim();
      updates.fcmToken = cleanToken;

      // Disassociate this token from any other account currently holding it
      await User.updateMany(
        { fcmToken: cleanToken, _id: { $ne: req.user._id } },
        { $set: { fcmToken: null } }
      );
    }
  }

  let user;
  try {
    user = await User.findByIdAndUpdate(req.user._id, updates, {
      new: true,
      runValidators: true,
    });
  } catch (err) {
    // If a concurrent race causes E11000 duplicate key on fcmToken, clear previous holder and retry
    if (err.code === 11000 && updates.fcmToken) {
      await User.updateMany(
        { fcmToken: updates.fcmToken, _id: { $ne: req.user._id } },
        { $set: { fcmToken: null } }
      );
      user = await User.findByIdAndUpdate(req.user._id, updates, {
        new: true,
        runValidators: true,
      });
    } else {
      throw err;
    }
  }

  return sendSuccess(res, {
    message: 'Profile updated',
    data: { user },
  });
});

/**
 * POST /api/auth/logout
 * Invalidate session by incrementing user's tokenVersion in MongoDB
 * and clearing the device fcmToken.
 * Subsequent requests with this token will fail authentication.
 */
const logout = asyncHandler(async (req, res) => {
  if (req.user?._id) {
    await User.findByIdAndUpdate(req.user._id, {
      $inc: { tokenVersion: 1 },
      $set: { fcmToken: null },
    });
    disconnectUserSockets(req.user._id.toString());
    logger.security('AUTH_LOGOUT', {
      requestId: req.id,
      userId: req.user._id.toString(),
      clientIp: req.ip,
    });
  }
  return sendSuccess(res, { message: 'Logged out successfully' });
});

/**
 * POST /api/auth/change-password
 * Updates password, increments tokenVersion to revoke all existing sessions,
 * and returns a new valid JWT.
 */
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const user = await User.findById(req.user._id).select('+passwordHash');
  if (!user) {
    return sendUnauthorized(res, 'User account not found');
  }

  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) {
    logger.security('AUTH_PASSWORD_CHANGE_FAILURE', {
      requestId: req.id,
      userId: req.user._id.toString(),
      reason: 'incorrect_current_password',
      clientIp: req.ip,
    });
    return sendUnauthorized(res, 'Current password is incorrect');
  }

  user.passwordHash = await User.hashPassword(newPassword);
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.fcmToken = null;
  await user.save();
  disconnectUserSockets(user._id.toString());

  logger.security('AUTH_PASSWORD_CHANGE', {
    requestId: req.id,
    userId: user._id.toString(),
    clientIp: req.ip,
  });

  const token = signToken(user._id.toString(), user.role, user.tokenVersion);

  return sendSuccess(res, {
    message: 'Password changed successfully. All other sessions revoked.',
    data: {
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        preferences: user.preferences,
      },
    },
  });
});

module.exports = {
  register,
  login,
  getMe,
  updateMe,
  logout,
  changePassword,
  registerValidation,
  loginValidation,
  changePasswordValidation,
  updateMeValidation,
};
