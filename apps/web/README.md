# Bondoq Customer Care Frontend

Arabic, RTL Next.js frontend for Halawani Bondoq's customer-care workspace.

## Requirements

- Node.js 20.9 or later
- npm
- The Bondoq API running and reachable from the browser

## Run locally

1. Copy `.env.example` to `.env.local` and set `NEXT_PUBLIC_API_URL` to the API's browser-accessible base URL. The default is `http://localhost:4000`.
2. Install dependencies and start the development server:

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`. The API URL is also used for the Socket.IO connection. Configure the API's CORS policy to allow the frontend origin.

## Screens

- `/login` - sign-in; routes users based on their account role.
- `/agent/workspace` - assigned conversations, live messages, customer profile and cake orders.
- `/admin/dashboard` - team overview, live conversation review, reassignment and private agent notes.
- `/` - checks the saved session and routes to the right workspace.

The agent workspace includes the Meta window countdown, approved WhatsApp template controls, quick product catalog, customer cake-reference attachment and print/PDF order ticket. The admin dashboard includes product catalog management and CSAT KPIs/alerts.

The standalone `bondoq-omnichannel-enterprise-preview.html` is a responsive visual demo with sample content; its interactions do not call the API.
