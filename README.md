# ArtHub Server - Backend API

## Purpose
This repository contains the backend Express server for the ArtHub marketplace. It provides the RESTful API endpoints required to handle authentication validation, artwork management, transactions, comments, and admin analytics. It serves as the data layer connecting the Next.js frontend with the MongoDB database and Stripe payment gateway.

## Live URL
https://arthub-server-nine.vercel.app/

## Key Features
*   **Secure API Endpoints**: Endpoints protected with JWT verification against the BetterAuth JWKS.
*   **Role Verification**: Middleware to restrict access for Artist and Admin specific routes.
*   **MongoDB Integration**: Native MongoDB driver integration for optimized database interactions.
*   **Stripe Webhook/Checkout fulfillment**: Handles checkout success verification and transaction recording.
*   **Data Aggregations**: Complex MongoDB aggregation pipelines for admin charts and analytics.

## NPM Packages Used
*   `express`
*   `mongodb`
*   `cors`
*   `dotenv`
*   `stripe`
*   `jose-cjs` (for auth verification)
