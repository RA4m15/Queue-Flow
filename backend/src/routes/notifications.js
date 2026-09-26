'use strict';

const router = require('express').Router();
const { protect, requireRole } = require('../middleware/auth');
const { validate, validateObjectId } = require('../middleware/validate');
const {
  list,
  markRead,
  markAllRead,
  broadcast,
  broadcastValidation,
} = require('../controllers/notificationController');

router.use(protect);

router.get('/', list);
router.patch('/read-all', markAllRead);
router.patch('/:id/read', validateObjectId('id'), markRead);
router.post('/broadcast', requireRole('ADMIN', 'STAFF'), broadcastValidation, validate, broadcast);

module.exports = router;
