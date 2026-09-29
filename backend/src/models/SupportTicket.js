'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

const SUPPORT_CATEGORIES = [
  'GENERAL',
  'TOKEN_ISSUE',
  'COUNTER_ISSUE',
  'APP_BUG',
  'BILLING',
  'OTHER',
];

const SUPPORT_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
const SUPPORT_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

const supportTicketSchema = new mongoose.Schema(
  {
    ticketId: {
      type: String,
      unique: true,
      index: true,
      trim: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
      index: true,
    },
    category: {
      type: String,
      enum: SUPPORT_CATEGORIES,
      default: 'GENERAL',
      required: [true, 'Category is required'],
    },
    subject: {
      type: String,
      required: [true, 'Subject is required'],
      trim: true,
      minlength: [3, 'Subject must be at least 3 characters'],
      maxlength: [200, 'Subject cannot exceed 200 characters'],
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
      minlength: [10, 'Description must be at least 10 characters'],
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
    },
    status: {
      type: String,
      enum: SUPPORT_STATUSES,
      default: 'OPEN',
      index: true,
    },
    priority: {
      type: String,
      enum: SUPPORT_PRIORITIES,
      default: 'MEDIUM',
    },
    resolutionNotes: {
      type: String,
      default: null,
      maxlength: 2000,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
        return ret;
      },
    },
  }
);

supportTicketSchema.pre('save', function (next) {
  if (!this.ticketId) {
    const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
    const ts = Date.now().toString().slice(-4);
    this.ticketId = `QF-TK-${ts}-${randomHex}`;
  }
  next();
});

module.exports = {
  SupportTicket: mongoose.model('SupportTicket', supportTicketSchema),
  SUPPORT_CATEGORIES,
  SUPPORT_STATUSES,
  SUPPORT_PRIORITIES,
};
