'use strict';

const { body } = require('express-validator');
const { SupportTicket, SUPPORT_CATEGORIES } = require('../models/SupportTicket');
const asyncHandler = require('../utils/asyncHandler');
const { sendCreated, sendSuccess, sendNotFound, sendForbidden, sendBadRequest } = require('../utils/apiResponse');
const { logger } = require('../utils/logger');

function normalizeCategory(cat) {
  if (!cat || typeof cat !== 'string') return 'GENERAL';
  const clean = cat.trim().toUpperCase().replace(/[\s\/-]+/g, '_');
  if (SUPPORT_CATEGORIES.includes(clean)) return clean;
  if (clean.includes('TOKEN') || clean.includes('QUEUE')) return 'TOKEN_ISSUE';
  if (clean.includes('COUNTER')) return 'COUNTER_ISSUE';
  if (clean.includes('BUG') || clean.includes('APP')) return 'APP_BUG';
  if (clean.includes('BILL')) return 'BILLING';
  if (clean.includes('GENERAL') || clean.includes('INQUIR')) return 'GENERAL';
  return 'OTHER';
}

const createTicketValidation = [
  body('subject')
    .isString()
    .trim()
    .isLength({ min: 3, max: 200 })
    .withMessage('Subject is required (3–200 characters)'),
  body('description')
    .isString()
    .trim()
    .isLength({ min: 10, max: 2000 })
    .withMessage('Description is required (10–2000 characters)'),
  body('category')
    .optional()
    .isString()
    .trim()
    .withMessage('Category must be a string'),
];

/**
 * POST /api/support/tickets
 * Create a persistent support ticket.
 * Requires authenticated user.
 */
const createTicket = asyncHandler(async (req, res) => {
  const { subject, description, category } = req.body;

  const validCategory = normalizeCategory(category);

  const ticket = await SupportTicket.create({
    userId: req.user._id,
    subject: subject.trim(),
    description: description.trim(),
    category: validCategory,
    status: 'OPEN',
  });

  logger.info('SUPPORT_TICKET_CREATED', {
    ticketId: ticket.ticketId,
    userId: req.user._id.toString(),
    category: ticket.category,
  });

  return sendCreated(res, {
    message: 'Support ticket submitted successfully',
    data: {
      ticket: {
        id: ticket._id,
        ticketId: ticket.ticketId,
        category: ticket.category,
        subject: ticket.subject,
        description: ticket.description,
        status: ticket.status,
        priority: ticket.priority,
        createdAt: ticket.createdAt,
      },
    },
  });
});

/**
 * GET /api/support/tickets
 * Retrieve tickets belonging to the current user.
 */
const getMyTickets = asyncHandler(async (req, res) => {
  const tickets = await SupportTicket.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  return sendSuccess(res, {
    data: {
      tickets: tickets.map((t) => ({
        id: t._id,
        ticketId: t.ticketId,
        category: t.category,
        subject: t.subject,
        description: t.description,
        status: t.status,
        priority: t.priority,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    },
  });
});

/**
 * GET /api/support/tickets/:id
 * Retrieve a specific ticket by id or ticketId.
 */
const getTicketById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  let ticket = null;
  if (/^[0-9a-fA-F]{24}$/.test(id)) {
    ticket = await SupportTicket.findById(id).lean();
  }
  if (!ticket) {
    ticket = await SupportTicket.findOne({ ticketId: id }).lean();
  }

  if (!ticket) {
    return sendNotFound(res, 'Support ticket not found');
  }

  // Customers can only see their own tickets
  if (req.user.role === 'CUSTOMER' && ticket.userId.toString() !== req.user._id.toString()) {
    return sendForbidden(res, 'Access denied to this support ticket');
  }

  return sendSuccess(res, {
    data: { ticket },
  });
});

module.exports = {
  createTicketValidation,
  createTicket,
  getMyTickets,
  getTicketById,
  normalizeCategory,
};
