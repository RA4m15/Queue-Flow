'use strict';

const router = require('express').Router();
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { passwordChangeLimiter } = require('../middleware/rateLimiter');
const {
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
} = require('../controllers/authController');

router.post('/register', registerValidation, validate, register);
router.post('/login', loginValidation, validate, login);
router.post('/logout', protect, logout);
router.post('/change-password', protect, passwordChangeLimiter, changePasswordValidation, validate, changePassword);
router.get('/me', protect, getMe);
router.patch('/me', protect, updateMeValidation, validate, updateMe);

module.exports = router;
