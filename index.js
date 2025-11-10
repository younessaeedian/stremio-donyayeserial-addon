import "dotenv/config"; // برای خواندن .env
import express from "express";
import cors from "cors";
import winston from "winston";
import { getCinemeta, getSubtitle, modifyUrls } from "./utils.js";
import Source from "./sources/source.js";
import DonyayeSerial from "./sources/donyayeserial.js";

// --- تنظیمات Logger ---
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

const addon = express();
addon.use(cors());

// --- مقداردهی اولیه Provider ---
const DonyayeSerialProvider = new DonyayeSerial(
  process.env.DONYESERIAL_BASEURL,
  logger
);
const ADDON_PREFIX = "ds_";

// --- مانیفست (شناسنامه) افزونه ---
const MANIFEST = {
  id: "com.donyayeserial.addon",
  version: "1.0.0", // نسخه را آپدیت کردیم
  contactEmail: "younessaeedian@gmail.com",
  description:
    "Enjoy watching the latest movies and series uncensored. (SUB = Subtitled | DUB = Dubbed)",
  logo: "https://donyayeserial.com/wp-content/uploads/2023/02/logo.png",
  name: "Donyaye Serial" + (process.env.DEV_MODE === "true" ? " - DEV" : ""),
  catalogs: [
    {
      name:
        "Donyaye Serial" + (process.env.DEV_MODE === "true" ? " - DEV" : ""),
      type: "movie",
      id: "donyayeserial_movies",
      extra: [{ name: "search", isRequired: true }],
    },
    {
      name:
        "Donyaye Serial" + (process.env.DEV_MODE === "true" ? " - DEV" : ""),
      type: "series",
      id: "donyayeserial_series",
      extra: [{ name: "search", isRequired: true }],
    },
  ],
  resources: [
    "catalog",
    { name: "meta", types: ["series", "movie"], idPrefixes: [ADDON_PREFIX] },
    { name: "stream", types: ["series", "movie"], idPrefixes: [ADDON_PREFIX] },
    {
      name: "subtitles",
      types: ["series", "movie"],
      idPrefixes: [ADDON_PREFIX],
    },
  ],
  types: ["movie", "series"],
};

addon.get("/manifest.json", function (req, res) {
  res.send(MANIFEST);
});

// --- روت جستجو (/catalog/...) ---
addon.get(
  "/catalog/:type/:id/:extraArgs.json",
  async function (req, res, next) {
    try {
      const args = { search: "", skip: 0 };
      if (req.params.extraArgs) {
        for (const item of decodeURIComponent(req.params.extraArgs).split(
          "&"
        )) {
          const [key, val] = item.split("=");
          args[key] = val;
        }
      }

      let data = [];

      if (req.params.id.includes("donyayeserial")) {
        const searchType = req.params.id.includes("movies") ? "post" : "series";
        data = await DonyayeSerialProvider.search(args.search, searchType);

        for (let i = 0; i < data.length; i++) {
          data[i].id =
            ADDON_PREFIX + DonyayeSerialProvider.providerID + data[i].id;
        }

        data = data.filter((i) => i.type === req.params.type);
      }

      res.send({ metas: data });
    } catch (e) {
      logger.error(e);
      res.send({ metas: {} });
    }
  }
);

// --- روت دریافت اطلاعات (/meta/...) ---
// --- این بلوک کامل و نهایی اصلاح شده است (بر اساس الگوی گیت‌هاب) ---
addon.get("/meta/:type/:id.json", async function (req, res, next) {
  try {
    let imdbId = "";
    let meta = {}; // این متغیر، اطلاعات نهایی Cinemeta خواهد بود

    // providerMovieId همان slug ما است (e.g., "true-detective")
    const providerMovieId = req.params.id.split(new Source().idSeparator)[1];
    const providerPrefix = DonyayeSerialProvider.providerID;

    // 1. ابتدا HTML صفحه را دانلود می‌کنیم
    const movieData = await DonyayeSerialProvider.getMovieData(
      req.params.type,
      providerMovieId
    );

    if (!!movieData) {
      // 2. سپس IMDB ID را از آن استخراج می‌کنیم
      imdbId = await DonyayeSerialProvider.imdbID(movieData);
    }

    if (imdbId && imdbId.length > 0) {
      // 3. حالا اطلاعات رسمی را از Stremio (Cinemeta) می‌گیریم
      meta = await getCinemeta(req.params.type, imdbId);
    }

    // 4. چک می‌کنیم که آیا Cinemeta اطلاعاتی برگردانده است یا خیر
    if (meta && meta.hasOwnProperty("meta")) {
      logger.debug(`Successfully fetched meta for ${imdbId} from Cinemeta.`);

      // 5. --- این بخش حیاتی است: بازنویسی ID ها ---
      // ما ID های رسمی Stremio را به ID های افزونه خودمان تغییر می‌دهیم

      if (req.params.type === "series") {
        if (meta.meta.videos) {
          for (let i = 0; i < meta.meta.videos.length; i++) {
            // بازنویسی ID قسمت: "ds_donyayeserial___true-detective___tt12345:1:1"
            meta.meta.videos[i].id =
              ADDON_PREFIX +
              providerPrefix +
              providerMovieId +
              new Source().idSeparator +
              meta.meta.videos[i].id;
          }
        }
        meta.meta.id = req.params.id; // بازنویسی ID اصلی سریال
      }

      if (req.params.type === "movie") {
        // بازنویسی ID فیلم: "ds_donyayeserial___black-bag___tt67890"
        meta.meta.id =
          ADDON_PREFIX +
          providerPrefix +
          providerMovieId +
          new Source().idSeparator +
          meta.meta.id;
        if (meta.meta.behaviorHints) {
          meta.meta.behaviorHints.defaultVideoId = meta.meta.id;
        }
      }
    } else if (movieData) {
      // 6. (حالت اضطراری) اگر Cinemeta شکست خورد (مثلاً IMDB ID پیدا نشد)
      logger.warn(`Cinemeta failed for ${imdbId}. Sending minimal meta.`);
      meta = {
        meta: {
          id: req.params.id,
          type: req.params.type,
          name: providerMovieId.replace(/-/g, " "), // "true-detective" -> "true detective"
          poster:
            (process.env.PROXY_ENABLE === "true"
              ? `${process.env.PROXY_URL}/${process.env.PROXY_PATH}?url=`
              : "") +
            "https://raw.githubusercontent.com/MrMohebi/stremio-ir-providers/refs/heads/master/logo.png",
          logo:
            (process.env.PROXY_ENABLE === "true"
              ? `${process.env.PROXY_URL}/${process.env.PROXY_PATH}?url=`
              : "") +
            "https://raw.githubusercontent.com/MrMohebi/stremio-ir-providers/refs/heads/master/logo.png",
        },
      };

      // اگر سریال بود، باید یک آرایه ویدئوی خالی بسازیم تا Stremio گیج نشود
      if (req.params.type === "series") {
        meta.meta.videos = []; // یک آرایه خالی برای قسمت‌ها
      }
    } else {
      logger.error(
        `Meta failed completely for ${providerMovieId}. Sending empty response.`
      );
      // meta خالی می‌ماند ( {} )
    }

    return res.send(meta); // ارسال متای بازنویسی شده
  } catch (e) {
    logger.error(e);
    res.send({});
  }
});

// --- روت دریافت لینک‌ها (/stream/...) ---
addon.get("/stream/:type/:id.json", async function (req, res, next) {
  try {
    // e.g., "ds_donyayeserial___true-detective___tt12345:1:1"
    const providerMovieId = req.params.id.split(new Source().idSeparator)[1]; // "true-detective"
    const imdbId = req.params.id.split(new Source().idSeparator)[2]; // "tt12345:1:1"

    let streams = [];

    // دوباره HTML صفحه را می‌گیریم (این کار لازم است چون state نداریم)
    const movieData = await DonyayeSerialProvider.getMovieData(
      req.params.type,
      providerMovieId
    );

    // لینک‌ها را استخراج می‌کنیم
    // --- شروع تغییر: ارسال providerMovieId ---
    // این پارامتر برای ساختن هدر 'Referer' در getSeriesLinks استفاده می‌شود
    streams = await DonyayeSerialProvider.getLinks(
      req.params.type,
      imdbId,
      movieData,
      providerMovieId // <-- این پارامتر حیاتی اضافه شد
    );
    // --- پایان تغییر ---

    return res.send({ streams });
  } catch (e) {
    logger.error(e);
    res.send({});
  }
});

// --- روت زیرنویس (/subtitles/...) ---
addon.get(
  "/subtitles/:type/:id/:extraArgs.json",
  async function (req, res, next) {
    try {
      const imdbId = req.params.id.split(new Source().idSeparator)[2];
      const data = await getSubtitle(req.params.type, imdbId); // از utils.js
      return res.send(data);
    } catch (e) {
      logger.error(e);
      res.send({});
    }
  }
);

// --- اجرای سرور ---
const port = process.env.PORT || 7001;
addon.listen(port, function () {
  logger.info(`Add-on Repository URL: http://127.0.0.1:${port}/manifest.json`);
  return "0.0.0.0";
});
