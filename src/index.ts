import express from "express";
const app= express();
import cookieParser from "cookie-parser";
app.use(express.json());
app.use(cookieParser());
import "dotenv/config"

import authRoutes from "./routes/auth.routes.js";


app.get("/", (req, res)=>{
    res.json({"message":"all is working fine"});

});
app.use("/api/auth", authRoutes);





const PORT= Number(process.env.PORT) || 3000;
app.listen(PORT, ()=>{
    console.log(`server is listening on port ${PORT}`);
});