# MidwayTicket API — NestJS Backend

> Production-ready REST API for the MidwayTicket platform.

## Tech Stack

| Layer          | Technology                         |
|----------------|------------------------------------|
| Framework      | NestJS + TypeScript                |
| Database       | PostgreSQL (via TypeORM)           |
| Cache          | Redis (cache-manager-redis-yet)    |
| Queue          | BullMQ (email, notifications)      |
| Auth           | Passport + JWT (RS256)             |
| Payments       | Razorpay                           |
| Documentation  | Swagger / OpenAPI                  |
| Container      | Docker + docker-compose            |

## Quick Start (Development)

```bash
# 1. Start database & cache
docker compose up postgres redis -d

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your values

# 4. Run migrations
npm run migration:run

# 5. Start the server
npm run start:dev
```

API available at: `http://localhost:3001/api/v1`  
Swagger docs at:  `http://localhost:3001/api/docs`

## API Endpoints

### Auth
```
POST /api/v1/auth/register          Register customer
POST /api/v1/auth/login/customer    Customer login → JWT
POST /api/v1/auth/login/operator    Operator login → JWT
POST /api/v1/auth/login/staff       Staff login → JWT (includes ride assignment)
```

### Fairs (Public)
```
GET  /api/v1/fairs                  List active fairs
GET  /api/v1/fairs?city=Kanpur      Filter by city
GET  /api/v1/fairs/:id              Fair detail with rides
```

### Rides (Public)
```
GET  /api/v1/rides/fair/:fairId     List rides for a fair
GET  /api/v1/rides/:id              Ride detail
```

### Bookings (Customer JWT)
```
POST /api/v1/bookings               Create booking → Razorpay order
POST /api/v1/bookings/verify        Verify payment → issue ticket
POST /api/v1/bookings/webhook       Razorpay webhook (no auth)
```

### Tickets (Customer JWT)
```
GET  /api/v1/tickets/mine           My tickets
GET  /api/v1/tickets/:id            Single ticket
GET  /api/v1/tickets/:displayId/qr  QR code data URL
POST /api/v1/tickets/redeem         Scan & redeem (SCANNER_STAFF only)
```

### Operator (Operator JWT)
```
POST /api/v1/fairs                  Create fair
PATCH /api/v1/fairs/:id             Update fair
POST /api/v1/rides/fair/:id         Add ride
PATCH /api/v1/rides/:id             Update ride
GET  /api/v1/staff                  List staff
POST /api/v1/staff                  Create staff account
PATCH /api/v1/staff/:id             Update staff (reassign ride)
DELETE /api/v1/staff/:id            Deactivate staff
GET  /api/v1/analytics/dashboard    Full dashboard stats
GET  /api/v1/analytics/weekly       7-day breakdown
```

### Staff (Scanner JWT)
```
GET  /api/v1/staff/me/assignment    Get own ride assignment
POST /api/v1/tickets/redeem         Scan a ticket (ride-locked)
```

## QR Ticket Redemption Flow

```
Staff scans QR
      ↓
POST /api/v1/tickets/redeem { qrToken, rideId, gate }
      ↓
[1] Redis: check used-token cache (fast path)
      ↓
[2] PostgreSQL transaction:
      SELECT ticket FOR UPDATE SKIP LOCKED
      → Ticket exists?          → INVALID
      → Payment confirmed?       → INVALID
      → Not expired?             → EXPIRED
      → Not already used?        → ALREADY_USED
      → Correct ride?            → WRONG_RIDE
      → All pass → UPDATE status = USED
      → INSERT scan_log
      → UPDATE staff.scansToday++
      ↓
[3] Redis: cache qrToken as used (24h TTL)
      ↓
[4] Return result to scanner UI
```

## Role-Based Access

| Role             | Access                                                    |
|------------------|-----------------------------------------------------------|
| CUSTOMER         | Browse fairs, book tickets, view own tickets              |
| OPERATOR_OWNER   | Full operator dashboard, staff management, analytics      |
| OPERATOR_MANAGER | Same as owner (minus billing)                             |
| SCANNER_STAFF    | Only: `GET /staff/me/assignment` + `POST /tickets/redeem` |

⚠️ **Security Note**: Scanner staff JWT includes `assignedRideId`. The backend verifies this claim against the database on every redemption request. The frontend role check is UI-only and not trusted.

## Environment Variables

See `.env.example` for all required variables.

## Database Migrations

```bash
npm run migration:run      # apply pending migrations
npm run migration:revert   # revert last migration
```

## Production Deployment

```bash
docker compose up --build
```

Recommended architecture:
```
Cloudflare (WAF + CDN)
      ↓
Vercel (Frontend: Next.js)
      ↓
Railway / Render (API: NestJS)
      ↓
Supabase / Neon (PostgreSQL)
Upstash (Redis)
```
