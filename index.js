const dns = require("node:dns");
dns.setServers(["1.1.1.1", "1.0.0.1"]);

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
dotenv.config();

const uri = process.env.MONGODB_URI;

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    credentials: true,
    origin: [process.env.CLIENT_URL],
  })
);
app.use(express.json());

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// BetterAuth JWKS Endpoint setup
const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL || "http://localhost:3000"}/api/auth/jwks`)
);

// Middleware to verify JWT Token
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ msg: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ msg: "Unauthorized" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload;
    next();
  } catch (error) {
    console.error("JWT Verification error:", error);
    return res.status(401).json({ msg: "Unauthorized" });
  }
};

// Middleware factory for verifying specific user roles
const verifyRole = (roles) => {
  return (req, res, next) => {
    const user = req.user;
    if (!user || !roles.includes(user.role)) {
      return res.status(403).json({ msg: "Forbidden: Access denied" });
    }
    next();
  };
};

const verifyArtist = verifyRole(["artist"]);
const verifyAdmin = verifyRole(["admin"]);

async function run() {
  try {
    await client.connect();
    const db = client.db("art-hub");

    // Collections
    const userCollection = db.collection("user");
    const artworkCollection = db.collection("artworks");
    const transactionCollection = db.collection("transactions");
    const commentCollection = db.collection("comments");
    const subscriptionCollection = db.collection("subscriptions");

    // =====================
    // Public APIs (Step 6)
    // =====================
    
    // GET: Featured Artworks (Latest 6)
    app.get("/api/artworks/featured", async (req, res) => {
      try {
        const featured = await artworkCollection
          .find({ status: { $ne: "sold" } }) // Don't show sold out items by default or just show them all
          .sort({ _id: -1 }) // simple way to get latest if no createdAt
          .limit(6)
          .toArray();
        res.json(featured);
      } catch (error) {
        console.error(error);
        res.status(500).json({ msg: "Failed to fetch featured artworks" });
      }
    });

    // GET: Top Artists
    app.get("/api/artists/top", async (req, res) => {
      try {
        const topArtists = await userCollection
          .find({ role: "artist" })
          .limit(3)
          .project({ name: 1, image: 1, email: 1 })
          .toArray();
        res.json(topArtists);
      } catch (error) {
        console.error(error);
        res.status(500).json({ msg: "Failed to fetch top artists" });
      }
    });

    // GET: Browse Artworks (Search, Filter, Sort, Pagination)
    app.get("/api/artworks", async (req, res) => {
      try {
        const { search, category, minPrice, maxPrice, sort, page = 1, limit = 8 } = req.query;
        
        let query = {};
        
        // Search by title or artistName
        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { artistName: { $regex: search, $options: "i" } }
          ];
        }
        
        // Filter by category
        if (category && category !== "all") {
          query.category = category;
        }
        
        // Filter by price range
        if (minPrice || maxPrice) {
          query.price = {};
          if (minPrice) query.price.$gte = Number(minPrice);
          if (maxPrice) query.price.$lte = Number(maxPrice);
        }

        // Exclude sold out artworks from public browsing by default
        query.status = { $ne: "sold" };

        // Sorting
        let sortOption = { _id: -1 }; // default: newest
        if (sort === "price-asc") sortOption = { price: 1 };
        if (sort === "price-desc") sortOption = { price: -1 };

        // Pagination
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        const totalArtworks = await artworkCollection.countDocuments(query);
        const totalPages = Math.ceil(totalArtworks / limitNum);

        const artworks = await artworkCollection
          .find(query)
          .sort(sortOption)
          .skip(skip)
          .limit(limitNum)
          .toArray();

        res.json({
          artworks,
          pagination: {
            totalItems: totalArtworks,
            totalPages,
            currentPage: pageNum,
            limit: limitNum
          }
        });
      } catch (error) {
        console.error("Error fetching artworks:", error);
        res.status(500).json({ msg: "Failed to fetch artworks" });
      }
    });

    // GET: Single Artwork Details
    app.get("/api/artworks/:id", async (req, res) => {
      try {
        const id = req.params.id;
        // Verify it's a valid ObjectId to prevent crashes
        if (!ObjectId.isValid(id)) {
          // If it's a placeholder ID (e.g. from UI mock), return dummy data
          if (["1", "2", "3", "4", "5", "6"].includes(id)) {
             return res.json({
               _id: id,
               title: "Golden Horizon",
               artistName: "Elena Rostova",
               artistId: "artist123",
               price: 450,
               category: "painting",
               description: "A beautiful exploration of light and shadow, capturing the ephemeral moments of twilight over the Mediterranean Sea. The intricate brushwork and warm color palette evoke a sense of deep tranquility and timeless beauty. Perfect for any modern or classical interior.",
               image: "https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?auto=format&fit=crop&q=80&w=1200",
               createdAt: new Date().toISOString(),
               status: "available"
             });
          }
          return res.status(400).json({ msg: "Invalid artwork ID format" });
        }

        const artwork = await artworkCollection.findOne({ _id: new ObjectId(id) });
        
        if (!artwork) {
          return res.status(404).json({ msg: "Artwork not found" });
        }

        res.json(artwork);
      } catch (error) {
        console.error("Error fetching artwork details:", error);
        res.status(500).json({ msg: "Failed to fetch artwork details" });
      }
    });

    // =====================
    // Artist Dashboard APIs (Step 9)
    // =====================

    // GET: All artworks belonging to the logged-in artist
    app.get("/api/artist/artworks", verifyToken, verifyArtist, async (req, res) => {
      try {
        const artistId = req.user.id;
        const myArtworks = await artworkCollection
          .find({ artistId })
          .sort({ _id: -1 })
          .toArray();
        res.json(myArtworks);
      } catch (error) {
        console.error("Error fetching artist artworks:", error);
        res.status(500).json({ msg: "Failed to fetch artworks" });
      }
    });

    // POST: Create new artwork
    app.post("/api/artworks", verifyToken, verifyArtist, async (req, res) => {
      try {
        const { title, description, price, category, image } = req.body;
        
        const newArtwork = {
          title,
          description,
          price: Number(price),
          category,
          image,
          artistId: req.user.id,
          artistName: req.user.name,
          status: "available",
          createdAt: new Date().toISOString()
        };

        const result = await artworkCollection.insertOne(newArtwork);
        res.status(201).json({ msg: "Artwork created successfully", id: result.insertedId });
      } catch (error) {
        console.error("Error creating artwork:", error);
        res.status(500).json({ msg: "Failed to create artwork" });
      }
    });

    // PUT: Update artwork
    app.put("/api/artworks/:id", verifyToken, verifyArtist, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).json({ msg: "Invalid ID" });

        const { title, description, price, category, image } = req.body;
        
        // Verify ownership
        const artwork = await artworkCollection.findOne({ _id: new ObjectId(id) });
        if (!artwork) return res.status(404).json({ msg: "Artwork not found" });
        if (artwork.artistId !== req.user.id) return res.status(403).json({ msg: "Forbidden" });

        const updatedData = {
          title,
          description,
          price: Number(price),
          category,
          image
        };

        await artworkCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedData }
        );

        res.json({ msg: "Artwork updated successfully" });
      } catch (error) {
        console.error("Error updating artwork:", error);
        res.status(500).json({ msg: "Failed to update artwork" });
      }
    });

    // DELETE: Delete artwork
    app.delete("/api/artworks/:id", verifyToken, verifyArtist, async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).json({ msg: "Invalid ID" });

        // Verify ownership
        const artwork = await artworkCollection.findOne({ _id: new ObjectId(id) });
        if (!artwork) return res.status(404).json({ msg: "Artwork not found" });
        if (artwork.artistId !== req.user.id) return res.status(403).json({ msg: "Forbidden" });

        await artworkCollection.deleteOne({ _id: new ObjectId(id) });
        res.json({ msg: "Artwork deleted successfully" });
      } catch (error) {
        console.error("Error deleting artwork:", error);
        res.status(500).json({ msg: "Failed to delete artwork" });
      }
    });

    // =====================
    // Stripe Checkout APIs (Step 11)
    // =====================
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

    // POST: Create Checkout Session for an Artwork
    app.post("/api/create-checkout-session", verifyToken, async (req, res) => {
      try {
        const { artworkId } = req.body;
        if (!ObjectId.isValid(artworkId)) return res.status(400).json({ msg: "Invalid artwork ID" });

        const artwork = await artworkCollection.findOne({ _id: new ObjectId(artworkId) });
        if (!artwork) return res.status(404).json({ msg: "Artwork not found" });
        if (artwork.status === "sold") return res.status(400).json({ msg: "Artwork is already sold" });
        if (artwork.artistId === req.user.id) return res.status(400).json({ msg: "You cannot buy your own artwork" });

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: artwork.title,
                  images: [artwork.image],
                  description: `Original artwork by ${artwork.artistName}`,
                },
                unit_amount: Math.round(artwork.price * 100), // Stripe expects cents
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          success_url: `${process.env.CLIENT_URL || "http://localhost:3000"}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_URL || "http://localhost:3000"}/artworks/${artworkId}`,
          metadata: {
            artworkId: artworkId,
            buyerId: req.user.id,
            buyerName: req.user.name,
            artistId: artwork.artistId,
            type: "artwork_purchase"
          },
        });

        res.json({ url: session.url });
      } catch (error) {
        console.error("Stripe session error:", error);
        res.status(500).json({ msg: "Failed to create checkout session" });
      }
    });

    // GET: Verify successful checkout and fulfill order
    app.get("/api/checkout-success", verifyToken, async (req, res) => {
      try {
        const { session_id } = req.query;
        if (!session_id) return res.status(400).json({ msg: "Session ID is required" });

        // Retrieve the session from Stripe
        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.payment_status !== "paid") {
          return res.status(400).json({ msg: "Payment not completed" });
        }

        const { artworkId, buyerId, buyerName, artistId } = session.metadata;

        // Check if transaction already exists (idempotency)
        const existingTx = await transactionCollection.findOne({ stripeSessionId: session_id });
        if (existingTx) {
          return res.json({ msg: "Order already fulfilled", transaction: existingTx });
        }

        // 1. Record the transaction
        const transaction = {
          stripeSessionId: session_id,
          artworkId,
          buyerId,
          buyerName,
          artistId,
          amount: session.amount_total / 100, // Convert back from cents
          currency: session.currency,
          createdAt: new Date().toISOString(),
          type: "artwork_purchase"
        };
        await transactionCollection.insertOne(transaction);

        // 2. Mark artwork as sold
        await artworkCollection.updateOne(
          { _id: new ObjectId(artworkId) },
          { $set: { status: "sold" } }
        );

        res.json({ msg: "Order fulfilled successfully", transaction });
      } catch (error) {
        console.error("Error fulfilling order:", error);
        res.status(500).json({ msg: "Failed to fulfill order" });
      }
    });

    // =====================
    // Stripe Subscription APIs (Step 12)
    // =====================

    // POST: Create Checkout Session for a Subscription
    app.post("/api/create-subscription-checkout", verifyToken, async (req, res) => {
      try {
        const { tier } = req.body;
        
        // Ensure valid tier
        if (tier !== "premium" && tier !== "pro") {
           return res.status(400).json({ msg: "Invalid subscription tier" });
        }

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price: "price_1TkQD9FMJJEHpxBR4qnTHMOs",
              quantity: 1,
            },
          ],
          mode: "subscription", 
          success_url: `${process.env.CLIENT_URL || "http://localhost:3000"}/pricing/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_URL || "http://localhost:3000"}/pricing`,
          metadata: {
            userId: req.user.id,
            tier: tier,
            type: "subscription_upgrade"
          },
        });

        res.json({ url: session.url });
      } catch (error) {
        console.error("Stripe subscription session error:", error);
        res.status(500).json({ msg: "Failed to create subscription checkout session" });
      }
    });

    // GET: Verify successful subscription and upgrade user
    app.get("/api/subscription-success", verifyToken, async (req, res) => {
      try {
        const { session_id } = req.query;
        if (!session_id) return res.status(400).json({ msg: "Session ID is required" });

        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.payment_status !== "paid") {
          return res.status(400).json({ msg: "Payment not completed" });
        }

        const { userId, tier } = session.metadata;

        // Check if transaction already exists (idempotency)
        const existingTx = await transactionCollection.findOne({ stripeSessionId: session_id });
        if (existingTx) {
          return res.json({ msg: "Upgrade already fulfilled", tier });
        }

        // 1. Record the transaction
        const transaction = {
          stripeSessionId: session_id,
          userId,
          amount: session.amount_total / 100, 
          currency: session.currency,
          createdAt: new Date().toISOString(),
          type: "subscription_upgrade",
          tier
        };
        await transactionCollection.insertOne(transaction);

        // 2. Upgrade user in database
        // Also update the session in better-auth? We just update the userCollection
        await userCollection.updateOne(
          { id: userId }, // better-auth uses string 'id' for the primary key
          { $set: { tier: tier } }
        );

        res.json({ msg: "Subscription successful", tier });
      } catch (error) {
        console.error("Error fulfilling subscription:", error);
        res.status(500).json({ msg: "Failed to fulfill subscription" });
      }
    });

    // =====================
    // Health Check
    // =====================
    app.get("/", (req, res) => {
      res.send("ArtHub server is running fine!");
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(PORT, () => {
  console.log(`ArtHub server running on port ${PORT}`);
});
