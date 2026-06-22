const dns = require("node:dns");
dns.setServers(["1.1.1.1", "1.0.0.1"]);

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const Stripe = require("stripe");

dotenv.config();

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const uri = process.env.MONGODB_URI;

const app = express();
const PORT = process.env.PORT || 5000;

const clientUrl = process.env.CLIENT_URL ? process.env.CLIENT_URL.replace(/['"]/g, "").trim().replace(/\/$/, "") : "";

app.use(
  cors({
    credentials: true,
    origin: [clientUrl],
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

let cachedClient = null;
const connectToDb = async () => {
  if (cachedClient) return cachedClient;
  cachedClient = await client.connect();
  return cachedClient;
};

app.use(async (req, res, next) => {
  try {
    await connectToDb();
    next();
  } catch (error) {
    console.error("Database connection middleware error:", error);
    res.status(500).json({ msg: "Database connection failed" });
  }
});

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const cookieHeader = req.headers.cookie;

    if (!authHeader && !cookieHeader) {
      return res.status(401).json({ msg: "Unauthorized: No token provided" });
    }

    // Forward the auth headers to BetterAuth on the Next.js server to validate
    const authRes = await fetch(`${process.env.CLIENT_URL || "http://localhost:3000"}/api/auth/get-session`, {
      headers: {
        cookie: cookieHeader || "",
        authorization: authHeader || ""
      }
    });

    if (!authRes.ok) {
      return res.status(401).json({ msg: "Unauthorized: Invalid session" });
    }

    const data = await authRes.json();
    if (!data || !data.user) {
      return res.status(401).json({ msg: "Unauthorized: User not found" });
    }

    req.user = data.user;
    next();
  } catch (error) {
    console.error("Session verification error:", error);
    return res.status(401).json({ msg: "Unauthorized: Internal error" });
  }
};

// Middleware factory for verifying specific user roles
const verifyRole = (roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ msg: "Forbidden: Access denied" });
    }
    next();
  };
};

const verifyArtist = verifyRole(["artist", "admin"]);
const verifyAdmin = verifyRole(["admin"]);

// Database collections initialized synchronously

const db = client.db("art-hub");

    // Collections
    const userCollection = db.collection("user");
    const artworkCollection = db.collection("artworks");
    const transactionCollection = db.collection("transactions");
    const commentCollection = db.collection("comments");
    const subscriptionCollection = db.collection("subscriptions");
    const accountCollection = db.collection("account");

    // GET: Check User Auth Methods
    app.get("/api/user/auth-methods", verifyToken, async (req, res) => {
      try {
        const userId = req.user.id;
        let queryId = userId;
        try {
          queryId = new ObjectId(userId);
        } catch (e) {
          // ignore error if not valid objectid
        }
        
        const accounts = await accountCollection.find({ 
          $or: [
            { userId: userId },
            { userId: queryId }
          ]
        }).toArray();
        const hasPassword = accounts.some(acc => acc.providerId === "credential");
        res.json({ hasPassword });
      } catch (error) {
        console.error("Error fetching auth methods:", error);
        res.status(500).json({ msg: "Failed to fetch auth methods" });
      }
    });

                
    // GET: Featured Artworks (Latest 6)
    app.get("/api/artworks/featured", async (req, res) => {
      try {
        const featured = await artworkCollection
          .find({})
          .sort({ _id: -1 })
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
        if (!ObjectId.isValid(id)) {
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
        if (artwork.status === "sold") return res.status(400).json({ msg: "Cannot update a sold artwork" });

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
        if (artwork.status === "sold") return res.status(400).json({ msg: "Cannot delete a sold artwork" });

        await artworkCollection.deleteOne({ _id: new ObjectId(id) });
        res.json({ msg: "Artwork deleted successfully" });
      } catch (error) {
        console.error("Error deleting artwork:", error);
        res.status(500).json({ msg: "Failed to delete artwork" });
      }
    });

    // POST: Create Checkout Session for an Artwork
    app.post("/api/create-checkout-session", verifyToken, async (req, res) => {
      try {
        const { artworkId } = req.body;
        if (!ObjectId.isValid(artworkId)) return res.status(400).json({ msg: "Invalid artwork ID" });

        const artwork = await artworkCollection.findOne({ _id: new ObjectId(artworkId) });
        if (!artwork) return res.status(404).json({ msg: "Artwork not found" });
        if (artwork.status === "sold") return res.status(400).json({ msg: "Artwork is already sold" });
        if (artwork.artistId === req.user.id) return res.status(400).json({ msg: "You cannot buy your own artwork" });

        // Check buyer subscription limits
        const buyer = await userCollection.findOne({ _id: new ObjectId(req.user.id) });
        const tier = buyer?.subscriptionTier || "free";
        const purchaseCount = buyer?.purchaseCount || 0;
        
        let limit = 3; // free
        if (tier === "pro") limit = 9;
        if (tier === "premium") limit = Infinity;
        
        if (purchaseCount >= limit) {
          return res.status(403).json({ 
            msg: `Purchase limit reached for your ${tier} plan. Please upgrade to continue.`, 
            code: "LIMIT_REACHED" 
          });
        }

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
                unit_amount: Math.round(artwork.price * 100),               },
              quantity: 1,
            },
          ],
          mode: "payment",
          success_url: `${clientUrl || "http://localhost:3000"}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${clientUrl || "http://localhost:3000"}/artworks/${artworkId}`,
          metadata: {
            artworkId: artworkId,
            artworkTitle: artwork.title,
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

                const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.payment_status !== "paid") {
          return res.status(400).json({ msg: "Payment not completed" });
        }

        const { artworkId, artworkTitle, buyerId, buyerName, artistId } = session.metadata;

                const existingTx = await transactionCollection.findOne({ stripeSessionId: session_id });
        if (existingTx) {
          return res.json({ msg: "Order already fulfilled", transaction: existingTx });
        }

                const transaction = {
          stripeSessionId: session_id,
          artworkId,
          artworkTitle,
          buyerId,
          buyerName,
          artistId,
          amount: session.amount_total / 100,           currency: session.currency,
          createdAt: new Date().toISOString(),
          type: "artwork_purchase",
          status: "completed"
        };
        await transactionCollection.insertOne(transaction);

                await artworkCollection.updateOne(
          { _id: new ObjectId(artworkId) },
          { $set: { status: "sold" } }
        );
        
        // Increment buyer's purchase count
        await userCollection.updateOne(
          { _id: new ObjectId(buyerId) },
          { $inc: { purchaseCount: 1 } }
        );

        // Dummy Email Notification
        console.log(`\n================= EMAIL NOTIFICATION =================`);
        console.log(`To: ${buyerName} <buyer@example.com>`);
        console.log(`Subject: Your Artwork Purchase Confirmation`);
        console.log(`Message: Thank you for purchasing "${artworkTitle}". The artist will ship it soon.`);
        console.log(`======================================================\n`);

        res.json({ msg: "Order fulfilled successfully", transaction });
      } catch (error) {
        console.error("Error fulfilling order:", error);
        res.status(500).json({ msg: "Failed to fulfill order" });
      }
    });

            
    // POST: Verify successful subscription and upgrade user
    app.post("/api/subscription/fulfill", verifyToken, async (req, res) => {
      try {
        const { session_id } = req.body;
        if (!session_id) return res.status(400).json({ msg: "Session ID is required" });

        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.payment_status !== "paid") {
          return res.status(400).json({ msg: "Payment not completed" });
        }

        const { userId, tier } = session.metadata;

                const existingTx = await transactionCollection.findOne({ stripeSessionId: session_id });
        if (existingTx) {
          return res.json({ msg: "Upgrade already fulfilled", tier });
        }

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

                await userCollection.updateOne(
          { _id: new ObjectId(userId) }, 
          { $set: { subscriptionTier: tier } }
        );

        // Dummy Email Notification
        console.log(`\n================= EMAIL NOTIFICATION =================`);
        console.log(`To: User ID ${userId}`);
        console.log(`Subject: Subscription Upgrade Successful`);
        console.log(`Message: You have successfully upgraded to the ${tier} tier!`);
        console.log(`======================================================\n`);

        res.json({ msg: "Subscription successful", tier });
      } catch (error) {
        console.error("Error fulfilling subscription:", error);
        res.status(500).json({ msg: "Failed to fulfill subscription" });
      }
    });

            
    // GET: User Purchase History
    app.get("/api/user/purchases", verifyToken, async (req, res) => {
      try {
        const userId = req.user.id;
        
        // Fetch artwork purchases where buyerId matches
        const purchases = await transactionCollection
          .find({ buyerId: userId, type: "artwork_purchase" })
          .sort({ _id: -1 })
          .toArray();

        // Enrich purchases with full artwork details
        const artworkIds = purchases.map(p => new ObjectId(p.artworkId));
        const artworks = await artworkCollection.find({ _id: { $in: artworkIds } }).toArray();
        
        const enrichedPurchases = purchases.map(p => {
          const artwork = artworks.find(a => a._id.toString() === p.artworkId);
          return {
            ...p,
            artwork: artwork || null
          };
        });

        res.json(enrichedPurchases);
      } catch (error) {
        console.error("Error fetching purchases:", error);
        res.status(500).json({ msg: "Failed to fetch purchase history" });
      }
    });

    // GET: Artist Sales History
    app.get("/api/artist/sales", verifyToken, verifyArtist, async (req, res) => {
      try {
        const artistId = req.user.id;
        
        const sales = await transactionCollection
          .find({ artistId: artistId, type: "artwork_purchase" })
          .sort({ _id: -1 })
          .toArray();

        res.json(sales);
      } catch (error) {
        console.error("Error fetching sales:", error);
        res.status(500).json({ msg: "Failed to fetch sales history" });
      }
    });

    // POST: Toggle Wishlist
    app.post("/api/wishlist/toggle", verifyToken, async (req, res) => {
      try {
        const { artworkId } = req.body;
        const userId = req.user.id;
        
        if (!artworkId) return res.status(400).json({ msg: "Artwork ID required" });

        const user = await userCollection.findOne({ _id: new ObjectId(userId) });
        const wishlist = user.wishlist || [];
        
        const isWishlisted = wishlist.includes(artworkId);
        
        if (isWishlisted) {
          await userCollection.updateOne(
            { _id: new ObjectId(userId) },
            { $pull: { wishlist: artworkId } }
          );
          res.json({ msg: "Removed from wishlist", isWishlisted: false });
        } else {
          await userCollection.updateOne(
            { _id: new ObjectId(userId) },
            { $addToSet: { wishlist: artworkId } }
          );
          res.json({ msg: "Added to wishlist", isWishlisted: true });
        }
      } catch (error) {
        console.error("Wishlist toggle error:", error);
        res.status(500).json({ msg: "Server error" });
      }
    });

    // GET: User Wishlist Artworks
    app.get("/api/wishlist", verifyToken, async (req, res) => {
      try {
        const userId = req.user.id;
        const user = await userCollection.findOne({ _id: new ObjectId(userId) });
        
        if (!user || !user.wishlist || user.wishlist.length === 0) {
          return res.json([]);
        }

        const objectIds = user.wishlist.map(id => {
          try { return new ObjectId(id); } catch (e) { return null; }
        }).filter(Boolean);
        
        const artworks = await artworkCollection.find({ _id: { $in: objectIds } }).toArray();
        res.json(artworks);
      } catch (error) {
        console.error("Fetch wishlist error:", error);
        res.status(500).json({ msg: "Server error" });
      }
    });

    // GET: Get current user details from database
    app.get("/api/user/details", verifyToken, async (req, res) => {
      try {
        const userId = req.user.id;
        const user = await userCollection.findOne({ _id: new ObjectId(userId) });
        if (!user) return res.status(404).json({ msg: "User not found" });
        res.json({
          id: user._id.toString(),
          name: user.name,
          email: user.email,
          role: user.role,
          subscriptionTier: user.subscriptionTier || "free",
          purchaseCount: user.purchaseCount || 0,
          bio: user.bio || "",
          image: user.image || ""
        });
      } catch (error) {
        console.error("Error fetching user details:", error);
        res.status(500).json({ msg: "Failed to fetch user details" });
      }
    });

    // PUT: Update User Profile
    app.put("/api/user/profile", verifyToken, async (req, res) => {
      try {
        const { bio } = req.body;
        const userId = req.user.id;

        // BetterAuth SDK handles name and image updates directly.
        // We use this endpoint for custom fields like bio.
        await userCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $set: { bio: bio || "" } }
        );

        res.json({ msg: "Profile updated successfully" });
      } catch (error) {
        console.error("Error updating profile:", error);
        res.status(500).json({ msg: "Failed to update profile" });
      }
    });

    // POST: Set Initial Role (For Google OAuth Onboarding)
    app.post("/api/user/set-initial-role", verifyToken, async (req, res) => {
      try {
        const userId = req.user.id;
        const { role } = req.body;
        
        if (!["user", "artist"].includes(role)) {
          return res.status(400).json({ msg: "Invalid role selected" });
        }

        // Must check if they currently have no role
        const currentUser = await userCollection.findOne({ _id: new ObjectId(userId) });
        if (currentUser && currentUser.role) {
          return res.status(403).json({ msg: "Role already set" });
        }

        await userCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $set: { role: role } }
        );

        res.json({ msg: "Role saved successfully" });
      } catch (error) {
        console.error("Error setting initial role:", error);
        res.status(500).json({ msg: "Failed to set role" });
      }
    });


    // GET: Fetch comments for an artwork
    app.get("/api/artworks/:id/comments", async (req, res) => {
      try {
        const artworkId = req.params.id;
        const comments = await commentCollection
          .find({ artworkId })
          .sort({ createdAt: -1 })
          .toArray();
        res.json(comments);
      } catch (error) {
        console.error("Error fetching comments:", error);
        res.status(500).json({ msg: "Failed to fetch comments" });
      }
    });

    // POST: Add a new comment
    app.post("/api/comments", verifyToken, async (req, res) => {
      try {
        const { artworkId, text } = req.body;
        
        if (!text || text.trim() === "") {
          return res.status(400).json({ msg: "Comment text is required" });
        }

        // Verify that the user has purchased the artwork
        const purchase = await transactionCollection.findOne({
          buyerId: req.user.id,
          artworkId: artworkId,
          type: "artwork_purchase",
          status: "completed"
        });

        if (!purchase) {
          return res.status(403).json({ msg: "You can only comment on artworks you have purchased" });
        }

        const newComment = {
          artworkId,
          userId: req.user.id,
          userName: req.user.name,
          text,
          createdAt: new Date().toISOString()
        };

        const result = await commentCollection.insertOne(newComment);
        res.status(201).json({ msg: "Comment added", comment: { ...newComment, _id: result.insertedId } });
      } catch (error) {
        console.error("Error adding comment:", error);
        res.status(500).json({ msg: "Failed to add comment" });
      }
    });

    // PUT: Edit a comment
    app.put("/api/comments/:id", verifyToken, async (req, res) => {
      try {
        const commentId = req.params.id;
        if (!ObjectId.isValid(commentId)) return res.status(400).json({ msg: "Invalid ID" });

        const { text } = req.body;
        if (!text || text.trim() === "") {
          return res.status(400).json({ msg: "Comment text is required" });
        }

        const comment = await commentCollection.findOne({ _id: new ObjectId(commentId) });
        if (!comment) return res.status(404).json({ msg: "Comment not found" });

        // Ensure user owns the comment
        if (comment.userId !== req.user.id) {
          return res.status(403).json({ msg: "Forbidden" });
        }

        await commentCollection.updateOne(
          { _id: new ObjectId(commentId) },
          { $set: { text, editedAt: new Date().toISOString() } }
        );

        res.json({ msg: "Comment updated" });
      } catch (error) {
        console.error("Error editing comment:", error);
        res.status(500).json({ msg: "Failed to update comment" });
      }
    });

    // DELETE: Delete a comment
    app.delete("/api/comments/:id", verifyToken, async (req, res) => {
      try {
        const commentId = req.params.id;
        if (!ObjectId.isValid(commentId)) return res.status(400).json({ msg: "Invalid ID" });

        const comment = await commentCollection.findOne({ _id: new ObjectId(commentId) });
        if (!comment) return res.status(404).json({ msg: "Comment not found" });

        // Ensure user owns the comment
        if (comment.userId !== req.user.id) {
          return res.status(403).json({ msg: "Forbidden" });
        }

        await commentCollection.deleteOne({ _id: new ObjectId(commentId) });
        res.json({ msg: "Comment deleted" });
      } catch (error) {
        console.error("Error deleting comment:", error);
        res.status(500).json({ msg: "Failed to delete comment" });
      }
    });


    // GET: Fetch all users
    app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const users = await userCollection.find({}, { projection: { password: 0 } }).toArray();
        res.json(users);
      } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({ msg: "Failed to fetch users" });
      }
    });

    // PUT: Update user role
    app.put("/api/admin/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const userId = req.params.id; // better-auth uses string IDs
        const { role } = req.body;

        if (!["user", "artist", "admin"].includes(role)) {
          return res.status(400).json({ msg: "Invalid role" });
        }

        // Prevent admin from removing their own admin role to avoid lockout
        if (userId === req.user.id && role !== "admin") {
          return res.status(400).json({ msg: "Cannot demote yourself" });
        }

        await userCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $set: { role: role } }
        );

        res.json({ msg: "Role updated successfully" });
      } catch (error) {
        console.error("Error updating role:", error);
        res.status(500).json({ msg: "Failed to update role" });
      }
    });

        // GET: Specific user details (for public profile view)
    app.get("/api/users/:id", async (req, res) => {
      try {
        const user = await userCollection.findOne(
          { _id: new ObjectId(req.params.id) },
          { projection: { password: 0, email: 0 } } // hide sensitive info
        );
        if (!user) return res.status(404).json({ msg: "User not found" });
        res.json(user);
      } catch (error) {
        console.error("Error fetching user:", error);
        res.status(500).json({ msg: "Failed to fetch user" });
      }
    });



    // GET: All artworks for admin
    app.get("/api/admin/artworks", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const artworks = await artworkCollection.find({}).sort({ createdAt: -1 }).toArray();
        res.json(artworks);
      } catch (error) {
        console.error("Error fetching artworks:", error);
        res.status(500).json({ msg: "Failed to fetch artworks" });
      }
    });

    // DELETE: Admin delete any artwork
    app.delete("/api/admin/artworks/:id", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await artworkCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        if (result.deletedCount === 0) {
          return res.status(404).json({ msg: "Artwork not found" });
        }
        res.json({ msg: "Artwork deleted" });
      } catch (error) {
        console.error("Error deleting artwork:", error);
        res.status(500).json({ msg: "Failed to delete artwork" });
      }
    });

    // PUT: Admin update artwork status
    app.put("/api/admin/artworks/:id/status", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { status } = req.body;
        const result = await artworkCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: status } }
        );
        if (result.matchedCount === 0) {
          return res.status(404).json({ msg: "Artwork not found" });
        }
        res.json({ msg: "Artwork status updated successfully" });
      } catch (error) {
        console.error("Error updating artwork status:", error);
        res.status(500).json({ msg: "Failed to update artwork status" });
      }
    });

    // GET: All transactions for admin
    app.get("/api/admin/transactions", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const transactions = await transactionCollection.find({}).sort({ createdAt: -1 }).toArray();
        res.json(transactions);
      } catch (error) {
        console.error("Error fetching transactions:", error);
        res.status(500).json({ msg: "Failed to fetch transactions" });
      }
    });

    // GET: Admin analytics summary
    app.get("/api/admin/analytics", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const totalUsers = await userCollection.countDocuments();
        const totalArtists = await userCollection.countDocuments({ role: "artist" });
        const totalArtworks = await artworkCollection.countDocuments();
        const totalArtworksSold = await artworkCollection.countDocuments({ status: "sold" });
        const totalTransactions = await transactionCollection.countDocuments();

        const revenueResult = await transactionCollection.aggregate([
          { $group: { _id: null, total: { $sum: "$amount" } } }
        ]).toArray();
        const totalRevenue = revenueResult[0]?.total || 0;

        res.json({
          totalUsers,
          totalArtists,
          totalArtworks,
          totalArtworksSold,
          totalTransactions,
          totalRevenue,
        });
      } catch (error) {
        console.error("Error fetching analytics:", error);
        res.status(500).json({ msg: "Failed to fetch analytics" });
      }
    });

    // GET: Chart data for admin analytics
    app.get("/api/admin/analytics/charts", verifyToken, verifyAdmin, async (req, res) => {
      try {
        // Category distribution
        const categoryData = await artworkCollection.aggregate([
          { $group: { _id: "$category", count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]).toArray();

        // Role distribution
        const roleData = await userCollection.aggregate([
          { $group: { _id: "$role", count: { $sum: 1 } } }
        ]).toArray();

        // Price range distribution
        const priceRanges = await artworkCollection.aggregate([
          {
            $bucket: {
              groupBy: "$price",
              boundaries: [0, 100, 300, 500, 1000, 5000],
              default: "5000+",
              output: { count: { $sum: 1 } }
            }
          }
        ]).toArray();

        // Monthly artwork creation (last 6 months)
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        const monthlyArtworks = await artworkCollection.aggregate([
          { $match: { createdAt: { $gte: sixMonthsAgo } } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
              count: { $sum: 1 }
            }
          },
          { $sort: { _id: 1 } }
        ]).toArray();

        // Monthly transactions (last 6 months)
        const monthlyTransactions = await transactionCollection.aggregate([
          { $match: { createdAt: { $gte: sixMonthsAgo } } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
              count: { $sum: 1 },
              revenue: { $sum: "$amount" }
            }
          },
          { $sort: { _id: 1 } }
        ]).toArray();

        res.json({
          categoryData: categoryData.map(c => ({ name: c._id || "Other", value: c.count })),
          roleData: roleData.map(r => ({ name: r._id || "user", value: r.count })),
          priceRanges: priceRanges.map(p => ({
            range: p._id === "5000+" ? "$5000+" : `$${p._id}`,
            count: p.count
          })),
          monthlyArtworks: monthlyArtworks.map(m => ({ month: m._id, artworks: m.count })),
          monthlyTransactions: monthlyTransactions.map(m => ({
            month: m._id,
            transactions: m.count,
            revenue: m.revenue
          })),
        });
      } catch (error) {
        console.error("Error fetching chart data:", error);
        res.status(500).json({ msg: "Failed to fetch chart data" });
      }
    });

        // Health Check
        app.get("/", (req, res) => {
      res.send("ArtHub server is running fine!");
    });

    // Connected to MongoDB in the background

app.listen(PORT, () => {
  console.log(`ArtHub server running on port ${PORT}`);
});
