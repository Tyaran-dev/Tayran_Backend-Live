// models/FinalBooking.js
import mongoose from "mongoose";

const FinalBookingSchema = new mongoose.Schema({
    invoiceId: { type: String, required: true, unique: true },
    status: {
        type: String,
        enum: ["CONFIRMED", "FAILED"],
        required: true,
    },
    orderData: { type: Object }, // Amadeus order response if success
    createdAt: { type: Date, default: Date.now },
});

const FinalBooking = mongoose.model("FinalBookingTicket", FinalBookingSchema);


export default FinalBooking;