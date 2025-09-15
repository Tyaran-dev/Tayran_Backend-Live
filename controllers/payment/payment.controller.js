import axios from "axios";
import { ApiError } from "../../utils/apiError.js";
import TempBookingTicket from "../../models/TempBooking.js";
import FinalBooking from "../../models/FinalBooking.js";
import crypto from "crypto";
import Airport from "../../models/airport.model.js";
import Airline from "../../models/Airline.model.js";

export const InitiateSession = async (req, res, next) => {
  try {
    const paymentBaseUrl = process.env.MYFATOORAH_API_URL;
    const token = process.env.MYFATOORAH_TEST_TOKEN;
    const resposne = await axios.post(
      `${paymentBaseUrl}/v2/InitiateSession`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    res.status(200).json({ data: resposne.data, status: resposne.status });
  } catch (error) {
    console.error("My Fatoorah InitiateSession Error:", error.message);
    return next(new ApiError(500, "Internal Server Error"));
  }
};

export const ExecutePayment = async (req, res, next) => {
  try {
    const { sessionId, invoiceValue, flightData, travelers } = req.body;
    const apiBase = process.env.MYFATOORAH_API_URL;
    const token = process.env.MYFATOORAH_TEST_TOKEN;

    if (!sessionId || !invoiceValue || !flightData || !travelers) {
      return next(new ApiError(400, "Missing required fields"));
    }

    // ✅ Tell MyFatoorah where to redirect after payment
    const successUrl = `${process.env.FRONTEND_URL}/thank-you`;
    const errorUrl = `${process.env.FRONTEND_URL}/payment-failed`;

    // Call MyFatoorah to execute the payment
    const { data } = await axios.post(
      `${apiBase}/v2/ExecutePayment`,
      {
        SessionId: sessionId,
        InvoiceValue: 1,
        ProcessingDetails: {
          AutoCapture: false, // We will capture in webhook after booking success
        },
        CallBackUrl: successUrl,
        ErrorUrl: errorUrl,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    const invoiceId = data?.Data?.InvoiceId;
    if (!invoiceId) {
      return next(new ApiError(500, "No InvoiceId returned from MyFatoorah"));
    }

    // Save temporary booking data to DB
    await TempBookingTicket.create({
      invoiceId,
      bookingData: {
        flightOffer: flightData,
        travelers: travelers,
      },
    });

    // Send Payment URL back to frontend
    res.status(200).json({
      success: true,
      paymentUrl: data?.Data?.PaymentURL,
      invoiceId,
    });
  } catch (err) {
    console.error("ExecutePayment error:", err?.response?.data || err.message);
    next(new ApiError(500, "ExecutePayment failed"));
  }
};

// ---------------- Helper ----------------
function formatDate(dateObj) {
  if (!dateObj) return null;

  // If already a string, try normal parsing
  if (typeof dateObj === "string") {
    const d = new Date(dateObj);
    return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
  }

  // Handle object { day, month, year }
  if (
    typeof dateObj === "object" &&
    dateObj.day &&
    dateObj.month &&
    dateObj.year
  ) {
    const { day, month, year } = dateObj;
    // Pad month/day with leading zeros
    const isoStr = `${year}-${String(month).padStart(2, "0")}-${String(
      day
    ).padStart(2, "0")}`;
    const d = new Date(isoStr);
    return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
  }

  return null;
}

function transformTravelers(travelersFromDb) {
  return travelersFromDb.map((t, index) => ({
    id: (index + 1).toString(), // Amadeus requires string id
    dateOfBirth: formatDate(t.dateOfBirth),
    name: {
      firstName: t.firstName,
      lastName: t.lastName,
    },
    gender: t.gender?.toUpperCase() || "MALE",
    contact: {
      emailAddress: t.email,
      phones: [
        {
          deviceType: "MOBILE",
          countryCallingCode: t.phoneCode?.replace("+", "") || "20",
          number: t.phoneNumber,
        },
      ],
    },
    documents: [
      {
        documentType: "PASSPORT",
        number: t.passportNumber,
        expiryDate: formatDate(t.passportExpiry),
        issuanceCountry: t.issuanceCountry, // ISO code
        nationality: t.nationality, // ISO code
        holder: true,
      },
    ],
  }));
}

export const PaymentWebhook = async (req, res) => {
  try {
    const secret = process.env.MYFATOORAH_WEBHOOK_SECRET;
    const signature = req.headers["myfatoorah-signature"];
    const { Data, Event } = req.body;

    if (!signature) {
      return res.status(400).json({ error: "Missing signature" });
    }
    if (!Data?.Invoice || !Data?.Transaction) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    // 🔹 Build signature string as per docs
    const fields = [
      `Invoice.Id=${Data.Invoice.Id || ""}`,
      `Invoice.Status=${Data.Invoice.Status || ""}`,
      `Transaction.Status=${Data.Transaction.Status || ""}`,
      `Transaction.PaymentId=${Data.Transaction.PaymentId || ""}`,
      `Invoice.ExternalIdentifier=${Data.Invoice.ExternalIdentifier || ""}`,
    ];
    const dataString = fields.join(",");

    // 🔹 Compute expected signature
    const expectedSignature = crypto
      .createHmac("sha256", Buffer.from(secret, "utf8"))
      .update(dataString, "utf8")
      .digest("base64");

    // console.log("🔹 Raw body:", JSON.stringify(req.body));
    // console.log("🔹 Signature string:", dataString);
    // console.log("🔹 Signature from header:", signature);
    // console.log("🔹 Expected signature:", expectedSignature);

    if (signature !== expectedSignature) {
      console.error("⚠️ Invalid webhook signature");
      return res.status(401).json({ error: "Invalid signature" });
    }
    console.log("✅ Webhook verified");

    // 🔹 Extract details
    const InvoiceId = Data.Invoice.Id;
    const InvoiceStatus = Data.Invoice.Status;
    const TransactionStatus = Data.Transaction.Status;
    const PaymentId = Data.Transaction.PaymentId;

    if (!InvoiceId) {
      return res.status(400).json({ error: "Missing InvoiceId" });
    }

    // Handle statuses
    if (TransactionStatus === "AUTHORIZE") {
      const tempBooking = await TempBookingTicket.findOne({
        invoiceId: InvoiceId,
      });

      if (!tempBooking) {
        console.error("No booking data found for invoice:", InvoiceId);
        return res.status(404).json({ error: "Booking not found" });
      }

      try {
        const rawBooking = tempBooking.bookingData;
        const transformedTravelers = transformTravelers(rawBooking.travelers);

        const bookingPayload = {
          flightOffer: rawBooking.flightOffer,
          travelers: transformedTravelers,
          ticketingAgreement: rawBooking.ticketingAgreement || {},
        };

        const response = await axios.post(
          `${process.env.BASE_URL}/flights/flight-booking`,
          bookingPayload
        );

        if (response.status === 201) {
          const orderData = response.data.order;

          // --- 1. Collect airline + airport codes from booking ---
          const airlineCodes = new Set();
          const airportCodes = new Set();

          orderData.data.flightOffers.forEach((offer) => {
            offer.itineraries.forEach((itinerary) => {
              itinerary.segments.forEach((segment) => {
                airlineCodes.add(segment.carrierCode);
                airportCodes.add(segment.departure.iataCode);
                airportCodes.add(segment.arrival.iataCode);
              });
            });
          });

          // --- 2. Fetch airlines ---
          const airlineDocs = airlineCodes.size
            ? await Airline.find({
                airLineCode: { $in: Array.from(airlineCodes) },
              })
            : [];

          const airlineMap = airlineDocs.reduce((map, airline) => {
            map[airline.airLineCode] = {
              id: airline._id,
              code: airline.airLineCode,
              name: {
                en: airline.airLineName,
                ar: airline.airlineNameAr,
              },
              image: `https://assets.wego.com/image/upload/h_240,c_fill,f_auto,fl_lossy,q_auto:best,g_auto/v20240602/flights/airlines_square/${airline.airLineCode}.png`,
            };
            return map;
          }, {});

          // --- 3. Fetch airports ---
          const airportDocs = await Airport.find({
            airport_code: { $in: Array.from(airportCodes) },
          });

          const airportMap = airportDocs.reduce((map, airport) => {
            map[airport.airport_code] = {
              id: airport._id,
              code: airport.airport_code,
              name: {
                en: airport.name_en,
                ar: airport.name_ar,
              },
              city: {
                en: airport.airport_city_en,
                ar: airport.airport_city_ar,
              },
              country: {
                en: airport.country_en,
                ar: airport.country_ar,
              },
            };
            return map;
          }, {});

          // --- 4. Save FinalBooking ---
          await FinalBooking.create({
            invoiceId: InvoiceId,
            paymentId: PaymentId, // ✅ save paymentId
            status: "CONFIRMED",
            orderData: {
              ...orderData,
              airlines: airlineMap, // multilingual airlines
              airports: airportMap, // multilingual airports
            }, // raw Amadeus order data
          });

          // capture the amount
          await axios.post(`${process.env.BASE_URL}/payment/captureAmount`, {
            Key: InvoiceId,
            KeyType: "InvoiceId",
          });
          console.log("✅ Booking success, payment captured:", InvoiceId);
        } else {
          // update status in db
          await FinalBooking.create({
            invoiceId: InvoiceId,
            status: "FAILED",
            orderData: response.data || null,
          });

          // release the amount
          await axios.post(`${process.env.BASE_URL}/payment/releaseAmount`, {
            Key: InvoiceId,
            KeyType: "InvoiceId",
          });
          console.log("❌ Booking failed, payment released:", InvoiceId);
        }
      } catch (err) {
        console.error(
          "Booking API failed:",
          err?.response?.data || err.message
        );
        await FinalBooking.create({
          invoiceId: InvoiceId,
          status: "FAILED",
          orderData: null,
          bookingPayload
        });
        await axios.post(`${process.env.BASE_URL}/payment/releaseAmount`, {
          Key: InvoiceId,
          KeyType: "InvoiceId",
        });
      }

      await TempBookingTicket.deleteOne({ invoiceId: InvoiceId });
    }

    if (TransactionStatus === "FAILED") {
      console.log("❌ Payment failed for invoice:", InvoiceId);
    }

    return res.status(200).json({ message: "Webhook processed" });
  } catch (err) {
    console.error("Webhook error:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Server error" });
  }
};

export const GetPaymentStatus = async (req, res, next) => {
  try {
    const { key, keyType } = req.body; // keyType can be 'InvoiceId' or 'PaymentId'
    const apiBase = process.env.MYFATOORAH_API_URL;
    const token = process.env.MYFATOORAH_TEST_TOKEN;

    const { data } = await axios.post(
      `${apiBase}/v2/GetPaymentStatus`,
      {
        Key: key,
        keyType: keyType,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.status(200).json(data);
  } catch (err) {
    console.error(
      "GetPaymentStatus error:",
      err?.response?.data || err.message
    );
    next(new ApiError(500, "GetPaymentStatus failed"));
  }
};

export const GetBookingStatus = async (req, res) => {
  try {
    const { paymentId } = req.body;

    const apiBase = process.env.MYFATOORAH_API_URL;
    const token = process.env.MYFATOORAH_TEST_TOKEN;

    const { data } = await axios.post(
      `${apiBase}/v2/GetPaymentStatus`,
      { Key: paymentId, KeyType: "PaymentId" },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const invoiceId = data?.Data?.InvoiceId;
    const transactions = data?.Data?.InvoiceTransactions || [];

    if (!invoiceId) {
      return res.json({ status: "PENDING" });
    }

    // 🔹 Check if already saved in DB
    const booking = await FinalBooking.findOne({ invoiceId });
    if (booking) {
      return res.json({
        status: booking.status,
        order: booking.orderData || null,
      });
    }

    // 🔹 Extract transaction statuses
    const statuses = transactions.map((t) => t.TransactionStatus);

    // 🚨 Priority 1: Failure cases
    if (
      statuses.includes("Failed") ||
      statuses.includes("Canceled") ||
      statuses.includes("Expired")
    ) {
      return res.json({ status: "FAILED" });
    }

    // ✅ Priority 2: Success cases
    if (statuses.includes("Paid") || statuses.includes("Captured")) {
      return res.json({ status: "CONFIRMED" });
    }

    // ⏳ Priority 3: Authorized but not yet captured
    if (statuses.includes("Authorize")) {
      return res.json({ status: "AUTHORIZED" });
    }

    // ⏳ Default fallback → still pending
    return res.json({ status: "PENDING" });
  } catch (err) {
    console.error(
      "GetBookingStatus error:",
      err?.response?.data || err.message
    );
    return res.status(500).json({ error: "Server error" });
  }
};

export const captureAuthorizedPayment = async (req, res, next) => {
  try {
    const { Key, KeyType } = req.body; // keyType can be 'InvoiceId' or 'PaymentId' => Amount

    const apiBase = process.env.MYFATOORAH_API_URL;
    const token = process.env.MYFATOORAH_TEST_TOKEN;

    const { data } = await axios.post(
      `${apiBase}/v2/UpdatePaymentStatus`,
      {
        Operation: "capture",
        Amount: 1,
        Key: Key,
        KeyType: KeyType,
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    res.status(200).json(data);
  } catch (err) {
    console.error(
      "captureAuthorizedPayment error:",
      err?.response?.data || err.message
    );
    next(new ApiError(500, "captureAuthorizedPayment failed"));
  }
};

export const releaseAuthorizedPayment = async (req, res, next) => {
  try {
    const { Key, KeyType } = req.body; // keyType can be 'InvoiceId' or 'PaymentId'ك

    console.log(Key, KeyType);

    const apiBase = process.env.MYFATOORAH_API_URL;
    const token = process.env.MYFATOORAH_TEST_TOKEN;

    const { data } = await axios.post(
      `${apiBase}/v2/UpdatePaymentStatus`,
      {
        Operation: "release",
        Amount: 1,
        Key: Key,
        KeyType: KeyType,
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log("released", data);
    res.status(200).json(data);
  } catch (err) {
    console.error(
      "releaseAuthorizedPayment error:",
      err?.response?.data || err.message
    );
    next(new ApiError(500, "releaseAuthorizedPayment failed"));
  }
};
