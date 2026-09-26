# QueueFlow Admin Web Panel

Real-time operations & management panel for the QueueFlow Smart Queue Management System.

Built with **React.js + Vite + Socket.IO Client + Recharts + Axios**.

---

## Features

* **Admin Authentication**: JWT-based role authentication (`ADMIN` and `STAFF`) connected to the backend.
* **Real-time Live Queue**: Synchronized live queue positions, waiting counts, and token status updates via Socket.IO.
* **Counter Management**: Interactive counter cards with Call Next, Start Serving, Complete, Skip, Break/Resume, Close/Open, and Service Reassignment.
* **IoT Live Footfall Sensor**: Live crowd occupancy bar with real-time updates.
* **Live Activity Log**: Audit trail of real operational events (`called`, `serving`, `done`, `break`, `skip`, `waiting`).
* **Standalone Counter Display**: Dedicated fullscreen display board (`/counter/:id`) for counter monitors.
* **Operational Analytics**: Recharts charts for hourly visitor footfall, service demand breakdown, and counter utilization.
* **Alerts & Smart Recommendations**: Real-time evidence-based operational suggestions and bulk broadcast announcements.

---

## Production Backend

```
https://queue-flow-4308.onrender.com
```

The Admin Panel connects to this Render-deployed backend. All data is stored in MongoDB Atlas. The Admin Panel **never** connects directly to the database.

---

## Environment Variables

### Production (`.env`)

Create `.env` in `admin_panel/` (gitignored):

```env
VITE_API_URL=https://queue-flow-4308.onrender.com
VITE_SOCKET_URL=https://queue-flow-4308.onrender.com
```

### Local Development Only (`.env`)

For local development with a locally-running backend:

```env
# LOCAL DEVELOPMENT ONLY — do not use in production
VITE_API_URL=http://localhost:5000
VITE_SOCKET_URL=http://localhost:5000
```

> **Warning**: Never use localhost URLs in production. The production `.env` must point to the Render backend.

---

## Development & Build

```bash
# Install dependencies
npm install

# Start development server (uses .env)
npm run dev

# Production build
npm run build

# Preview production build
npm run preview
```

---

## Production Integration Test

The integration test runs against the **live Render backend** only. No local backend is required or started.

### Setup

Create `.env.test` in `admin_panel/` (gitignored — never commit):

```env
TEST_API_URL=https://queue-flow-4308.onrender.com/api
TEST_SOCKET_URL=https://queue-flow-4308.onrender.com
IOT_SECRET=<get from Render environment settings>
TEST_ADMIN_EMAIL=<admin account email>
TEST_ADMIN_PASSWORD=<admin account password>
TEST_STAFF_EMAIL=<staff account email>
TEST_STAFF_PASSWORD=<staff account password>
TEST_CUSTOMER_PASSWORD=<password for temporary test customer accounts>
```

> **Security**: Do not place real passwords or secrets in this README or any committed file. All credentials belong in `.env.test` (gitignored) or in the Render environment configuration.

### Run

```bash
npm test
```

The test verifies:
- Production health check
- Admin & Staff authentication
- Dashboard API (Queue, Counters, Crowd, Analytics)
- Token lifecycle: WAITING → CALLED → SERVING → COMPLETED → SKIP
- Real IoT crowd ENTRY/EXIT
- Socket.IO real-time event delivery
- Counter Display synchronization

---

## Security Notes

- `.env` and `.env.test` are gitignored and must never be committed
- JWT tokens are stored in `localStorage` under `queueflow_admin_token`
- 401 responses automatically clear the session and redirect to `/login`
- CUSTOMER role accounts are blocked at the UI layer (`AuthContext`) and at the backend
- No secrets, passwords, or MongoDB credentials appear in source code or build artifacts

---

## Architecture

```
React Admin Panel
      ↓  HTTPS + WebSocket
Render Backend (https://queue-flow-4308.onrender.com)
      ↓
MongoDB Atlas
```

The Admin Panel does **not** connect directly to MongoDB.
