# AI-Based Intelligent Traffic Management System

## Overview

This hackathon project is the foundation for a simulation of 20 autonomous vehicles approaching a four-way intersection. It will eventually combine batch AI recommendations with deterministic safety validation to coordinate vehicle movement safely and efficiently.

**Currently implemented:** a React/Vite frontend, an Express API, a backend health endpoint, and local development tooling.  
**Not yet implemented:** vehicle simulation, intersection rendering, Gemini integration, safety validation, real-time updates, or analytics.

## Problem

Fixed traffic controls do not adapt well to changing vehicle demand. This project will explore coordinated, multi-vehicle traffic decisions while retaining a deterministic safety layer as the final authority over movement.

## Technology stack

- Frontend: React, Vite, JavaScript, CSS
- Backend: Node.js, Express, JavaScript ES modules
- Development: npm, nodemon, concurrently, dotenv

## Architecture

The `client` and `server` are separate applications. React requests `/api/health`; during development, Vite proxies that request to Express at `http://localhost:5000`. This keeps backend addresses out of frontend code.

```text
Browser (React, :5173) -> /api/health -> Vite proxy -> Express API (:5000)
                                                    -> JSON health response
```

## Folder structure

```text
.
├── client/
│   ├── public/
│   ├── src/
│   │   ├── components/ services/ hooks/ styles/
│   │   ├── App.jsx  App.css  index.css  main.jsx
│   ├── index.html
│   └── vite.config.js
├── server/
│   ├── src/
│   │   ├── ai/ analytics/ config/ controllers/ middleware/ routes/
│   │   ├── safety/ services/ simulation/
│   │   ├── app.js
│   │   └── server.js
│   └── .env.example
├── package.json
└── .gitignore
```

The empty domain folders are reserved for later modules.

## Prerequisites

- Node.js 20.19+ or 22.12+
- npm

## Installation

```bash
npm install
npm install --prefix client
npm install --prefix server
```

## Environment configuration

Copy the example and adjust values only if needed:

```bash
cp server/.env.example server/.env
```

`server/.env` is ignored by Git. Keep API keys only in backend environment files; none are required for this module.

## Run the applications

Start both applications:

```bash
npm run dev
```

Start them separately:

```bash
npm run client
npm run server
```

Open `http://localhost:5173` for the frontend. The API listens on `http://localhost:5000`.

## Test the health endpoint

With the backend running:

```bash
curl http://localhost:5000/api/health
```

Expected fields include `success: true`, `data.status: "healthy"`, and a dynamic ISO timestamp. Unknown API paths return a structured JSON 404 response.

## Vite API proxy

`client/vite.config.js` forwards any request starting with `/api` from Vite (port 5173) to Express (port 5000). Therefore React can use `fetch('/api/health')` without embedding a backend URL; this proxy is for development.

## Planned modules

1. Traffic state, vehicle model, and intersection simulation
2. Intersection visualization and vehicle animation
3. Gemini batch decision integration
4. Deterministic safety validation and fallback control
5. Live updates, metrics, and analytics
