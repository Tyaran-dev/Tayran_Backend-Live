// models/FinalBooking.js
import mongoose from "mongoose";

const FinalBookingSchema = new mongoose.Schema({
  invoiceId: { type: String, required: true, unique: true },
  paymentId: { type: String }, // optional, only available on confirmed payments
  status: {
    type: String,
    enum: ["CONFIRMED", "FAILED"],
    required: true,
  },
  InvoiceValue: { type: Number }, // store invoice total
  bookingType: { type: String }, // flight, hotel, etc.
  orderData: { type: Object }, // Amadeus order response if success
  bookingPayload: { type: Object }, // raw booking payload if failed or for debugging
  createdAt: { type: Date, default: Date.now },
});

const FinalBooking = mongoose.model("FinalBookingTicket", FinalBookingSchema);

export default FinalBooking;
