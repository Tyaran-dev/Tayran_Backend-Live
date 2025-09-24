import axios from "axios";
import { ApiError } from "../../utils/apiError.js";

const presentageCommission = 5;

const formatDate = (dateStr) => {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = `0${date.getMonth() + 1}`.slice(-2);
  const day = `0${date.getDate()}`.slice(-2);
  return `${year}-${month}-${day}`;
};

export const getCountryList = async (req, res, next) => {
  try {
    const userName = process.env.TBO_USER_NAME,
      passwrod = process.env.TBO_PASSWORD;
    const reponse = await axios.get(
      "http://api.tbotechnology.in/TBOHolidays_HotelAPI/CountryList",
      {
        auth: {
          username: userName,
          password: passwrod,
        },
      }
    );
    return res.status(200).json({ data: reponse.data.CountryList });
  } catch (error) {
    next(
      new ApiError(
        error.response?.status || 500,
        error.response?.data?.errors?.[0]?.detail ||
        "Error searching for countries"
      )
    );
  }
};

export const getCityList = async (req, res, next) => {
  try {
    const userName = process.env.TBO_USER_NAME,
      passwrod = process.env.TBO_PASSWORD;

    const { CountryCode } = req.body;

    const reponse = await axios.post(
      "http://api.tbotechnology.in/TBOHolidays_HotelAPI/CityList",
      {
        CountryCode,
      },
      {
        auth: {
          username: userName,
          password: passwrod,
        },
      }
    );
    return res.status(200).json({ data: reponse.data.CityList });
  } catch (error) {
    next(
      new ApiError(
        error.response?.status || 500,
        error.response?.data?.errors?.[0]?.detail ||
        "Error searching for cities"
      )
    );
  }
};

const PER_PAGE = 30;
// === Helper: split array into chunks ===
const chunkArray = (array, size) => {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
};

// === Helper: limit concurrency ===
const pLimit = (concurrency) => {
  const queue = [];
  let activeCount = 0;

  const next = () => {
    activeCount--;
    if (queue.length > 0) queue.shift()();
  };

  const run = async (fn, resolve, args) => {
    activeCount++;
    const result = (async () => fn(...args))();
    result.then(resolve).then(next, next);
  };

  const enqueue = (fn, args) =>
    new Promise((resolve) => {
      queue.push(run.bind(null, fn, resolve, args));
      if (activeCount < concurrency) {
        queue.shift()();
      }
    });

  return (fn, ...args) => enqueue(fn, args);
};

// === Main Controller ===
export const hotelsSearch = async (req, res, next) => {
  try {
    console.log("search starting");
    const userName = process.env.TBO_USER_NAME;
    const password = process.env.TBO_PASSWORD;

    const {
      CheckIn,
      CheckOut,
      CityCode,
      GuestNationality,
      PreferredCurrencyCode = "SAR",
      PaxRooms,
      Language = "EN",
      page = 1,
    } = req.body;

    // Step 0: Basic validation
    if (!CityCode || !CheckIn || !CheckOut || !PaxRooms || !GuestNationality) {
      return next(
        new ApiError(400, "Missing required fields for hotel search")
      );
    }

    // Step 1: Fetch hotel codes for the city
    const hotelCodesRes = await axios.post(
      "http://api.tbotechnology.in/TBOHolidays_HotelAPI/TBOHotelCodeList",
      { CityCode },
      { auth: { username: userName, password } }
    );

    const allHotelCodes =
      hotelCodesRes.data?.Hotels?.map((h) => h.HotelCode) || [];

    if (allHotelCodes.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No hotel codes found for the selected city.",
      });
    }

    // Step 2: Fetch available rooms in hotels (batched + concurrent)
    const limit = pLimit(10); // max 10 parallel requests
    const hotelChunks = chunkArray(allHotelCodes, 50); // each request ≤ 50 codes
    const batchChunks = chunkArray(hotelChunks, 10); // group 10x50 = 500 per cycle

    let searchResults = [];
    for (const batch of batchChunks) {
      const results = await Promise.all(
        batch.map((codes, indx) => {
          console.log(codes, indx, "here is the current bAtch");
          return limit(() =>
            axios.post(
              "http://api.tbotechnology.in/TBOHolidays_HotelAPI/Search",
              {
                CheckIn: formatDate(CheckIn),
                CheckOut: formatDate(CheckOut),
                HotelCodes: codes.join(","), // max 50
                GuestNationality,
                PreferredCurrencyCode,
                PaxRooms,
                ResponseTime: 23.0,
                IsDetailedResponse: true,
                Filters: {
                  Refundable: false,
                  NoOfRooms: "All",
                  MealType: "All",
                },
              },
              {
                auth: { username: userName, password },
              }
            )
          );
        })
      );

      const batchResults = results.flatMap((r) => r.data?.HotelResult || []);
      searchResults = [...searchResults, ...batchResults];
    }

    const aviailableHotelCodes = searchResults.map((r) => r.HotelCode);

    // Step 3: Paginate available hotel codes
    const startIndex = (page - 1) * PER_PAGE;
    const currentBatchArray = aviailableHotelCodes.slice(
      startIndex,
      startIndex + PER_PAGE
    );

    if (currentBatchArray.length === 0) {
      return res.status(400).json({
        success: false,
        message: `No hotels found for page ${page}.`,
      });
    }

    const currentBatch = currentBatchArray.join(",");

    // Step 4: Fetch hotel details
    const hotelDetailsRes = await axios.post(
      "http://api.tbotechnology.in/TBOHolidays_HotelAPI/HotelDetails",
      { Hotelcodes: currentBatch, Language },
      { auth: { username: userName, password } }
    );

    const hotelDetails = hotelDetailsRes.data?.HotelDetails || [];

    // Step 5: Merge hotel details with pricing
    const enrichedHotels = hotelDetails.map((hotel) => {
      const matched = searchResults.find(
        (result) => result.HotelCode === hotel.HotelCode
      );
      return {
        ...hotel,
        MinHotelPrice:
          matched?.Rooms?.[0]?.DayRates?.[0]?.[0]?.BasePrice || null,
        presentageCommission
      };
    });

    // Step 6: Return results
    return res.status(200).json({
      success: true,
      data: enrichedHotels,
      pagination: {
        page,
        perPage: PER_PAGE,
        total: aviailableHotelCodes.length,
        totalPages: Math.ceil(aviailableHotelCodes.length / PER_PAGE),
      },
    });
  } catch (error) {
    console.error(
      "Hotel search error:",
      error?.response?.data || error.message
    );
    next(
      new ApiError(
        error.response?.status || 500,
        error.response?.data?.errors?.[0]?.detail ||
        "Error searching for hotels"
      )
    );
  }
};

export const getHotelDetails = async (req, res, next) => {
  try {
    const userName = process.env.TBO_USER_NAME,
      password = process.env.TBO_PASSWORD;

    const {
      CheckIn,
      CheckOut,
      CityCode,
      HotelCodes,
      GuestNationality,
      PreferredCurrencyCode = "SAR",
      PaxRooms,
      Language = "EN",
    } = req.body;

    if (!HotelCodes) {
      return next(new ApiError(400, "Hotel codes are required"));
    }

    const hotelSearchPayload = {
      CheckIn: formatDate(CheckIn),
      CheckOut: formatDate(CheckOut),
      CityCode,
      HotelCodes,
      GuestNationality,
      PreferredCurrencyCode,
      PaxRooms,
      ResponseTime: 23.0,
      IsDetailedResponse: true,
      Filters: {
        Refundable: false,
        NoOfRooms: "All",
        MealType: "All",
      },
    };

    const hotelDetails = await axios.post(
      "http://api.tbotechnology.in/TBOHolidays_HotelAPI/HotelDetails",
      { HotelCodes, Language },
      {
        auth: {
          username: userName,
          password,
        },
      }
    );

    const hotel = hotelDetails.data.HotelDetails;

    const getRooms = await axios.post(
      "http://api.tbotechnology.in/TBOHolidays_HotelAPI/Search",
      hotelSearchPayload,
      { auth: { username: userName, password } }
    );

    console.log(getRooms, "hereeeeeeeeeee");
    const availableRooms = getRooms.data?.HotelResult[0].Rooms || [];
    // console.log(availableRooms, "avilaible rooooooooms")

    return res.status(200).json({
      data: {
        hotel,
        availableRooms,
        presentageCommission
      },
    });
  } catch (error) {
    next(
      new ApiError(
        error.response?.status || 500,
        error.response?.data?.errors?.[0]?.detail ||
        "Error searching for Hotel Details "
      )
    );
  }
};

export const preBookRoom = async (req, res, next) => {
  try {
    const userName = process.env.TBO_USER_NAME,
      password = process.env.TBO_PASSWORD,
      { BookingCode } = req.body;

    const response = await axios.post(
      "http://api.tbotechnology.in/TBOHolidays_HotelAPI/PreBook",
      {
        BookingCode,
        PaymentMode: "NewCard",
      },
      { auth: { username: userName, password } }
    );

    return res.status(200).json({
      data: response.data,
    });
  } catch (error) {
    next(
      new ApiError(
        error.response?.status || 500,
        error.response?.data?.errors?.[0]?.detail ||
        "Error searching for Hotel Details "
      )
    );
  }
};

export const bookRoom = async (req, res, next) => {
  try {
    const userName = process.env.TBO_USER_NAME;
    const password = process.env.TBO_PASSWORD;

    const {
      BookingCode,
      CustomerDetails,
      ClientReferenceId,
      BookingReferenceId,
      TotalFare,
      EmailId,
      PhoneNumber,
      BookingType,
      PaymentMode,
      Supplements, // optional
    } = req.body;

    // Compose the request payload
    const payload = {
      BookingCode,
      CustomerDetails,
      ClientReferenceId,
      BookingReferenceId,
      TotalFare,
      EmailId,
      PhoneNumber,
      BookingType,
      PaymentMode,
    };

    if (Supplements && Supplements.length > 0) {
      payload.Supplements = Supplements;
    }

    const response = await axios.post(
      "http://api.tbotechnology.in/TBOHolidays_HotelAPI/Book",
      payload,
      { auth: { username: userName, password } }
    );

    return res.status(200).json({
      success: true,
      message: "Booking successful",
      data: response.data,
    });
  } catch (error) {
    next(
      new ApiError(
        error.response?.status || 500,
        error.response?.data?.errors?.[0]?.detail ||
        "Error searching for Hotel Details"
      )
    );
  }
};

export const BookingDetails = async (req, res, next) => {
  try {
    const userName = process.env.TBO_USER_NAME;
    const password = process.env.TBO_PASSWORD;

    const { BookingReferenceId } = req.body;

    if (!BookingReferenceId) {
      return res.status(400).json({
        success: false,
        message: "BookingReferenceId is required",
      });
    }

    const detailsResponse = await axios.post(
      "http://api.tbotechnology.in/TBOHolidays_HotelAPI/BookingDetail",
      {
        BookingReferenceId: BookingReferenceId,
        PaymentMode: "PayLater", // or the mode you actually use
      },
      {
        auth: {
          username: userName,
          password: password,
        },
      }
    );

    // forward TBO API response to client
    return res.status(200).json({
      success: true,
      data: detailsResponse.data,
    });
  } catch (error) {
    console.error("BookingDetails error:", error?.response?.data || error);

    return next(
      new ApiError(
        error.response?.status || 500,
        error.response?.data?.errors?.[0]?.detail ||
        error.response?.data?.error ||
        "Error fetching booking details from TBO"
      )
    );
  }
};