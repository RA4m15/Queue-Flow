'use strict';

const router = require('express').Router();
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const {
  createTicketValidation,
  createTicket,
  getMyTickets,
  getTicketById,
} = require('../controllers/supportController');

router.post('/tickets', protect, createTicketValidation, validate, createTicket);
router.get('/tickets', protect, getMyTickets);
router.get('/tickets/:id', protect, getTicketById);

module.exports = router;
