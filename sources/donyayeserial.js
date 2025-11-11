import Source from "./source.js";
import Axios from "axios";
import { parse } from "node-html-parser";
import { logAxiosError, searchAndGetTMDB } from "../utils.js"; // searchAndGetTMDB از utils.js می‌آید

export default class DonyayeSerial extends Source {
  constructor(baseURL, logger) {
    super(baseURL, logger);
    this.providerID = "donyayeserial" + this.idSeparator;
  }

  // لاگین نیاز نیست
  async isLogin() {
    return true;
  }
  async login() {
    return true;
  }

  async search(text, type = "post") {
    try {
      this.logger.debug(`DonyayeSerial searching for ${text} (type: ${type})`);

      // --- شروع تغییر ۱: اصلاح نحوه کدگذاری جستجو ---
      // سایت جستجوی پیشرفته انتظار دارد فاصله‌ها (spaces) به‌جای %20 با + کدگذاری شوند
      // این کار باعث می‌شود هم "Emerald" و هم "Emerald City" به درستی کار کنند
      const encodedText = encodeURIComponent(text).replace(/%20/g, "+");

      const searchUrl = `https://${this.baseURL}/?s=${encodedText}&search_type=advanced&post_type=${type}`;

      this.logger.debug(`Searching URL: ${searchUrl}`);
      // --- پایان تغییر ۱ ---

      // --- شروع تغییر ۲: افزودن هدرهای مرورگر به جستجو ---
      const res = await Axios.get(searchUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          Referer: `https://${this.baseURL}/`,
        },
      });
      // --- پایان تغییر ۲ ---

      const root = parse(res.data);
      const results = root.querySelectorAll("article.postItems");

      const items = [];
      if (!results || results.length === 0) {
        // لاگ بهتر برای دیباگ
        this.logger.warn(
          `DonyayeSerial found no results for "${text}" (type: ${type})`
        );
        return items;
      }

      this.logger.debug(`Found ${results.length} results on search page.`);

      for (const item of results) {
        const titleTag = item.querySelector(".post-title h2 a");
        if (!titleTag) continue;

        const href = titleTag.getAttribute("href");
        let title = titleTag.getAttribute("title") || titleTag.rawText;
        title = title
          .replace("دانلود فیلم", "")
          .replace("دانلود سریال", "")
          .trim();

        const slug = href.split("/").filter(Boolean).pop();
        if (!slug) continue;

        const posterTag = item.querySelector(".imgWrapper img");
        const poster = posterTag ? posterTag.getAttribute("src") : "";

        const movie = {
          name: title,
          poster: poster,
          type: type === "post" ? "movie" : "series",
          id: slug,
        };
        items.push(movie);
      }
      return items;
    } catch (e) {
      logAxiosError(e, this.logger, "DonyayeSerial search error: ");
    }
    return [];
  }

  async getMovieData(type, id) {
    try {
      this.logger.debug(
        `DonyayeSerial getting movie data for id ${id} (type: ${type})`
      );

      const path = type === "series" ? `/series/${id}/` : `/${id}/`;
      const finalUrl = `https://${this.baseURL}${path}`;

      this.logger.debug(`Fetching meta from: ${finalUrl}`);

      // --- شروع تغییر ۳: افزودن هدرهای مرورگر به دریافت متا ---
      const res = await Axios.get(finalUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          Referer: `https://${this.baseURL}/`, // ارجاع از صفحه اصلی
        },
      });
      // --- پایان تغییر ۳ ---

      return res.data;
    } catch (e) {
      logAxiosError(
        e,
        this.logger,
        `DonyayeSerial getMovieData error for id ${id}: `
      );
    }
    return null;
  }

  /**
   * تابع استخراج IMDB ID (نسخه نهایی و هوشمند)
   */
  async imdbID(movieData) {
    try {
      const root = parse(movieData);

      // 1. روش اول (سریع): پیدا کردن لینک IMDB در صفحه
      const imdbLink = root.querySelector(
        'a.fm-box-imdb[href*="imdb.com/title/"]'
      );
      if (imdbLink) {
        const href = imdbLink.getAttribute("href");
        const imdbId = href.match(/(tt\d+)/);
        if (imdbId && imdbId[0]) {
          this.logger.debug(`Found IMDB ID ${imdbId[0]} from page (Method 1).`);
          return imdbId[0];
        }
      }

      // 2. روش دوم (پشتیبان): جستجو در TMDB
      this.logger.warn(
        "Could not find IMDB ID on page. Falling back to TMDB (Method 2)."
      );

      // --- بخش هوشمندسازی ---
      // 2.1. استخراج عنوان
      const titleEl = root.querySelector("h1");
      if (!titleEl) {
        this.logger.error("Fallback failed: Could not find title <h1> tag.");
        return null;
      }
      let title = titleEl.rawText
        .replace("دانلود فیلم", "")
        .replace("دانلود سریال", "")
        .trim();

      // 2.2. استخراج سال (برای جستجوی دقیق‌تر)
      let year = null;
      const yearEl = root.querySelector('span.pr-item a[href*="/release/"]'); // <a ... href=".../release/2021/">2021</a>
      if (yearEl) {
        year = yearEl.rawText.trim();
        this.logger.debug(`Found year: ${year}`);
      }

      // 2.3. تمیز کردن عنوان (حذف سال، پرانتز، و کلمات اضافه)
      // e.g., "Black.Widow.(2021).SoftSub" -> "Black Widow"
      const cleanTitle = title
        .replace(/[\(\.\s]\d{4}[\)]?.*$/i, "") // حذف سال (e.g. 2021) و هرچیزی بعد از آن
        .replace(/\./g, " ") // تبدیل نقطه به فاصله
        .trim();
      // --- پایان بخش هوشمندسازی ---

      if (cleanTitle === "Unknown" || !cleanTitle) {
        this.logger.error(
          "Fallback failed: Could not parse a valid title from <h1>."
        );
        return null;
      }

      this.logger.debug(
        `Searching TMDB for cleaned title: "${cleanTitle}" and year: "${year}"`
      );

      // 2.4. بررسی وجود کلید API
      if (!process.env.TMDB_API_KEY) {
        this.logger.error(
          "Fallback failed: TMDB_API_KEY is missing from .env file."
        );
        return null;
      }

      // 2.5. جستجو در TMDB (از utils.js)
      const tmdbData = await searchAndGetTMDB(cleanTitle, year); // <--- ارسال عنوان و سال

      if (tmdbData && tmdbData.external_ids && tmdbData.external_ids.imdb_id) {
        this.logger.debug(
          `Found IMDB ID ${tmdbData.external_ids.imdb_id} from TMDB.`
        );
        return tmdbData.external_ids.imdb_id;
      }
    } catch (e) {
      this.logger.error(`Error finding IMDB ID: ${e.message}`);
    }

    this.logger.error("IMDB ID could not be found by any method.");
    return null; // Return null if all else fails
  }

  /**
   * تابع استخراج لینک‌های فیلم (بر اساس دانلود.html)
   */
  getMovieLinks(movieData) {
    const links = [];
    const root = parse(movieData);

    const linkBox = root.querySelector(".dl-box-alert.--notif");
    if (!linkBox) {
      this.logger.error(
        "Could not find movie download box .dl-box-alert.--notif"
      );
      return links;
    }

    const linkTags = linkBox.querySelectorAll("a");
    this.logger.debug(
      `Found ${linkTags.length} <a> tags in movie download box.`
    );

    for (const linkTag of linkTags) {
      try {
        const url = linkTag.getAttribute("href");
        const title = linkTag.rawText;

        if (url && (url.includes(".mkv") || url.includes(".mp4"))) {
          let cleanTitle = title
            .replace("دانلود با کیفیت", "")
            .replace("دانلود", "")
            .trim();

          if (url.includes("/Dubbed/")) {
            cleanTitle = `(DUB) ${cleanTitle}`;
          } else if (url.includes("/SoftSub/")) {
            cleanTitle = `(SUB) ${cleanTitle}`;
          }

          links.push({
            url: url,
            title: cleanTitle,
          });
        }
      } catch (e) {
        this.logger.error(`Error parsing a movie link: ${e.message}`);
      }
    }

    if (links.length === 0) {
      this.logger.warn(
        "Finished parsing movie, but found 0 valid .mkv/.mp4 links."
      );
    }
    return links;
  }

  // تابع کمکی برای تبدیل عدد فصل به متن فارسی
  mapSeasonToText(seasonNumber) {
    const seasons = [
      "",
      "فصل اول",
      "فصل دوم",
      "فصل سوم",
      "فصل چهارم",
      "فصل پنجم",
      "فصل ششم",
      "فصل هفتم",
      "فصل هشتم",
      "فصل نهم",
      "فصل دهم",
      "فصل یازدهم",
      "فصل دوازدهم",
    ];
    if (seasonNumber < seasons.length) {
      return seasons[seasonNumber];
    }
    return `فصل ${seasonNumber}`;
  }

  // تابع کمکی (اصلاح شده) برای پیدا کردن فایل قسمت در یک پوشه
  findEpisodeFile(seasonNumber, episodeNumber, mkvFileUrls) {
    const s = seasonNumber.toString().padStart(2, "0");
    const e = episodeNumber.toString().padStart(2, "0");

    // الگوهای دقیق در اولویت هستند
    const patterns = [
      `s${s}e${e}`, // s01e01
      `.e${e}.`, // .e01.
      `_e${e}_`, // _e01_
      `-e${e}-`, // -e01-
      `(${s}x${e})`, // (01x01)
    ];

    // الگوی قدیمی به عنوان فال‌بک
    const fallbackPattern = `E${episodeNumber.toString().padStart(2, "0")}`; // E01

    this.logger.debug(
      `Searching for patterns: ${patterns.join(
        ", "
      )} or fallback: ${fallbackPattern}`
    );

    let potentialMatch = null;

    for (const fileUrl of mkvFileUrls) {
      const lowerUrl = fileUrl.toLowerCase();

      // چک کردن الگوهای دقیق
      for (const pat of patterns) {
        if (lowerUrl.includes(pat)) {
          this.logger.debug(`Found precise match: ${fileUrl}`);
          return fileUrl;
        }
      }

      // اگر مطابقت دقیق پیدا نشد، الگوی قدیمی را چک می‌کنیم
      if (!potentialMatch && fileUrl.includes(fallbackPattern)) {
        this.logger.debug(`Found potential fallback match: ${fileUrl}`);
        potentialMatch = fileUrl;
      }
    }

    // اگر هیچکدام از الگوهای دقیق مطابقت نداشت، به فال‌بک اعتماد می‌کنیم
    if (potentialMatch) {
      this.logger.debug(`Using fallback match: ${potentialMatch}`);
      return potentialMatch;
    }

    this.logger.warn(
      `Could not find match for S${s}E${e} in ${mkvFileUrls.length} files`
    );
    return null;
  }

  /**
   * تابع استخراج لینک‌های سریال (بر اساس mirror.html و لینک‌های پوشه)
   * --- این تابع به طور کامل بازنویسی شده است ---
   */
  async getSeriesLinks(movieData, imdbId, providerMovieId) {
    const streams = [];
    try {
      const seasonNumber = +imdbId.split(":")[1];
      const episodeNumber = +imdbId.split(":")[2];
      this.logger.debug(`Getting links for S${seasonNumber}E${episodeNumber}`);

      const seasonText = this.mapSeasonToText(seasonNumber);
      const root = parse(movieData);

      const downloadBox = root.querySelector(".dl-box-alert.--notif");
      if (!downloadBox) {
        this.logger.error(
          "Could not find series download box .dl-box-alert.--notif"
        );
        return streams;
      }

      // --- شروع تغییر ۴: تعریف هدرهای مرورگر ---
      // این هدرها باعث می‌شوند درخواست ما شبیه یک کاربر واقعی به نظر برسد
      // ما از providerMovieId (مثل: money-heist) برای ساختن Referer استفاده می‌کنیم
      const refererUrl = providerMovieId
        ? `https://${this.baseURL}/series/${providerMovieId}/`
        : `https://${this.baseURL}/`;

      const browserHeaders = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,fa;q=0.8",
        Referer: refererUrl, // <-- مهم: صفحه ارجاع‌دهنده را مشخص می‌کنیم
      };
      this.logger.debug(`Using Referer: ${refererUrl}`);
      // --- پایان تغییر ۴ ---

      // --- شروع تغییر ۵: استفاده از querySelectorAll به جای childNodes ---
      // این روش بسیار قوی‌تر است و نودهای متنی خالی را نادیده می‌گیرد
      const allElements = downloadBox.querySelectorAll("h3, p, hr");
      if (!allElements || allElements.length === 0) {
        this.logger.error("Could not find any h3/p/hr tags in download box.");
        return streams;
      }

      let foundSeasonBlock = false;
      const seasonDirectoryUrls = [];

      for (const element of allElements) {
        const tag = element.tagName.toLowerCase();
        const text = element.rawText;

        // اگر تگ H3 مربوط به فصل مورد نظر را پیدا کردیم
        if (tag === "h3" && text.includes(seasonText)) {
          foundSeasonBlock = true;
          this.logger.debug(`Found season block: ${seasonText}`);
          continue;
        }

        // اگر به تگ H3 یا HR بعدی رسیدیم، یعنی بلاک فصل تمام شده
        if ((tag === "h3" || tag === "hr") && foundSeasonBlock) {
          this.logger.debug("End of season block.");
          break;
        }

        // اگر در بلاک فصل بودیم و تگ P پیدا کردیم
        if (foundSeasonBlock && tag === "p") {
          const linkTag = element.querySelector("a");
          if (linkTag) {
            const url = linkTag.getAttribute("href");
            const title = linkTag.rawText;

            // لینک‌های پوشه همان‌هایی هستند که http دارند ولی mkv/mp4 ندارند
            if (
              url &&
              url.startsWith("http") &&
              !url.includes(".mkv") &&
              !url.includes(".mp4")
            ) {
              this.logger.debug(`Found directory link: ${title} -> ${url}`);
              seasonDirectoryUrls.push({ url, title });
            }
          }
        }
      }
      // --- پایان تغییر ۵ ---

      this.logger.debug(
        `Found ${seasonDirectoryUrls.length} quality directories for S${seasonNumber}`
      );
      if (seasonDirectoryUrls.length === 0) {
        this.logger.warn(
          `No directory URLs found for ${seasonText}. Parsing logic might have failed.`
        );
      }

      for (const dir of seasonDirectoryUrls) {
        try {
          this.logger.debug(`Fetching episode list from directory: ${dir.url}`);

          // --- شروع تغییر ۶: اضافه کردن هدرها به درخواست ---
          const dirRes = await Axios.get(dir.url, {
            headers: browserHeaders, // <--- هدرها اینجا اعمال می‌شوند
          });
          // --- پایان تغییر ۶ ---

          const dirRoot = parse(dirRes.data);

          // این سلکتور برای فایل Index of.xhtml عالی عمل می‌کند
          const mkvTags = dirRoot.querySelectorAll('a[href$=".mkv"]');
          if (mkvTags.length === 0) {
            this.logger.warn(`No .mkv files found in directory: ${dir.url}`);
            continue;
          }

          const mkvFileUrls = mkvTags.map((tag) => tag.getAttribute("href"));

          const episodeFile = this.findEpisodeFile(
            seasonNumber,
            episodeNumber,
            mkvFileUrls
          );

          if (episodeFile) {
            let fullEpisodeUrl = episodeFile;

            // فایل Index of.xhtml لینک کامل (absolute) می‌دهد
            if (!episodeFile.startsWith("http")) {
              const baseUrl = dir.url.endsWith("/") ? dir.url : dir.url + "/";
              fullEpisodeUrl = baseUrl + episodeFile;
            }

            const cleanTitle = dir.title
              .replace("لینک های دانلود کیفیت", "")
              .replace("کلیک کنید", "")
              .trim();

            streams.push({
              url: fullEpisodeUrl,
              title: `(S${seasonNumber}E${episodeNumber}) - ${cleanTitle}`,
            });
            this.logger.debug(`Successfully found stream: ${fullEpisodeUrl}`);
          } else {
            this.logger.warn(
              `Could not find E${episodeNumber} in directory: ${dir.url}`
            );
          }
        } catch (e) {
          logAxiosError(
            e,
            this.logger,
            `Failed to fetch/parse directory ${dir.url}`
          );
        }
      }
    } catch (e) {
      this.logger.debug(`Error parsing series links => ${imdbId}`);
      this.logger.error(e.message);
    }

    if (streams.length === 0) {
      this.logger.warn(
        `Finished parsing series, but found 0 streams for S${seasonNumber}E${episodeNumber}.`
      );
    }
    return streams;
  }

  /**
   * تابع اصلی انتخاب منطق (حالا async است)
   * --- امضای تابع تغییر کرده است ---
   */
  async getLinks(type, imdbId, movieData, providerMovieId = null) {
    if (!movieData) {
      this.logger.error("getLinks called with no movieData.");
      return [];
    }

    if (type === "movie") {
      return this.getMovieLinks(movieData);
    }
    if (type === "series") {
      // --- شروع تغییر ۷: ارسال providerMovieId ---
      return await this.getSeriesLinks(movieData, imdbId, providerMovieId);
      // --- پایان تغییر ۷ ---
    }
    return [];
  }
}
