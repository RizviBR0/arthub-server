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
