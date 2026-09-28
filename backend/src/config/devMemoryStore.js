'use strict';

const SEED_USERS = {
  'admin@queueflow.dev': {
    _id: '64f1a2b3c4d5e6f7a8b9c0d1',
    name: 'Sarah Mehta (Admin)',
    email: 'admin@queueflow.dev',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 0,
    password: 'Admin@1234',
  },
  'staff1@queueflow.dev': {
    _id: '64f1a2b3c4d5e6f7a8b9c0d2',
    name: 'Sarah Mehta',
    email: 'staff1@queueflow.dev',
    role: 'STAFF',
    isActive: true,
    tokenVersion: 0,
    password: 'Staff@1234',
  },
  'staff2@queueflow.dev': {
    _id: '64f1a2b3c4d5e6f7a8b9c0d3',
    name: 'Rajan Mehta',
    email: 'staff2@queueflow.dev',
    role: 'STAFF',
    isActive: true,
    tokenVersion: 0,
    password: 'Staff@1234',
  },
  'customer1@example.com': {
    _id: '64f1a2b3c4d5e6f7a8b9c0d4',
    name: 'Priya Sharma',
    email: 'customer1@example.com',
    role: 'CUSTOMER',
    isActive: true,
    tokenVersion: 0,
    password: 'Customer@1234',
  },
  'ram@example.com': {
    _id: '64f1a2b3c4d5e6f7a8b9c0d5',
    name: 'Ram',
    email: 'ram@example.com',
    role: 'CUSTOMER',
    isActive: true,
    tokenVersion: 0,
    password: 'Customer@1234',
  },
};

const devUsersByEmail = new Map();
const devUsersById = new Map();

// Initialize with seed users
Object.values(SEED_USERS).forEach((u) => {
  devUsersByEmail.set(u.email.toLowerCase(), u);
  devUsersById.set(u._id, u);
});

function getDevUserByEmail(email) {
  if (!email) return null;
  return devUsersByEmail.get(email.toLowerCase().trim()) || null;
}

function getDevUserById(id) {
  if (!id) return null;
  return devUsersById.get(id.toString()) || null;
}

function registerDevUser({ name, email, password, role = 'CUSTOMER', phone }) {
  const normEmail = email.toLowerCase().trim();
  const id = '64f1a2b3c4d5e6f7' + Math.random().toString(16).slice(2, 10);
  const user = {
    _id: id,
    name: name || normEmail.split('@')[0],
    email: normEmail,
    role: role || 'CUSTOMER',
    phone: phone || undefined,
    isActive: true,
    tokenVersion: 0,
    password: password || 'Customer@1234',
    createdAt: new Date(),
    lastLogin: new Date(),
  };
  devUsersByEmail.set(normEmail, user);
  devUsersById.set(id, user);
  return user;
}

module.exports = {
  SEED_USERS,
  devUsersByEmail,
  devUsersById,
  getDevUserByEmail,
  getDevUserById,
  registerDevUser,
};
