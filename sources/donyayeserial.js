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
      const searchUrl = `https://${this.baseURL}/?s=${encodeURIComponent(
        text
      )}&search_type=advanced&post_type=${type}`;

      const res = await Axios.get(searchUrl);
      const root = parse(res.data);

      const results = root.querySelectorAll("article.postItems");

      const items = [];
      if (!results || results.length === 0) {
        this.logger.warn(`DonyayeSerial found no results for "${text}"`);
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
      const res = await Axios.get(finalUrl);
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

  // تابع کمکی برای پیدا کردن فایل قسمت در یک پوشه
  findEpisodeFile(seasonNumber, episodeNumber, mkvFileUrls) {
    const epStr1 = `E${episodeNumber.toString().padStart(2, "0")}`;
    const epStr2 = `s${seasonNumber.toString().padStart(2, "0")}e${episodeNumber
      .toString()
      .padStart(2, "0")}`;

    // --- تغییر پیشنهادی: بهبود منطق تطبیق ---
    // این الگوها دقیق‌تر هستند و از تطابق اشتباه (مثلا E1 با E11) جلوگیری می‌کنند
    const s = seasonNumber.toString().padStart(2, "0");
    const e = episodeNumber.toString().padStart(2, "0");
    const patterns = [
      `s${s}e${e}`, // s01e01
      `${seasonNumber}x${e}`, // 1x01
      `.e${e}.`, // .e01.
      `_e${e}_`, // _e01_
      `-e${e}-`, // -e01-
    ];

    this.logger.debug(`Searching for patterns: ${patterns.join(", ")}`);

    for (const fileUrl of mkvFileUrls) {
      const lowerUrl = fileUrl.toLowerCase();

      // چک کردن الگوهای دقیق‌تر
      for (const pat of patterns) {
        if (lowerUrl.includes(pat)) {
          return fileUrl;
        }
      }
    }

    // --- فال‌بک به منطق قدیمی (کمی شل‌تر) ---
    // این منطق 'E01' را در 'S01E01' پیدا می‌کند
    this.logger.warn(
      `Precise patterns failed. Falling back to old logic: ${epStr1} or ${epStr2}`
    );
    for (const fileUrl of mkvFileUrls) {
      if (fileUrl.includes(epStr1) || fileUrl.toLowerCase().includes(epStr2)) {
        this.logger.debug(`Fallback match found: ${fileUrl}`);
        return fileUrl;
      }
    }

    this.logger.warn(
      `Could not find match for ${epStr1} or ${epStr2} in ${mkvFileUrls.length} files`
    );
    return null;
  }

  /**
   * تابع استخراج لینک‌های سریال (بر اساس mirror.html و لینک‌های پوشه)
   * --- این تابع به طور کامل بازنویسی شده است تا قوی‌تر عمل کند ---
   */
  async getSeriesLinks(movieData, imdbId) {
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

      // --- شروع تغییر: استفاده از querySelectorAll به جای childNodes ---
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

            // لینک‌های پوشه همان‌هایی هستند که http دارند ولی mkv ندارند
            if (url && url.startsWith("http") && !url.includes(".mkv")) {
              seasonDirectoryUrls.push({ url, title });
            }
          }
        }
      }
      // --- پایان تغییر ---

      this.logger.debug(
        `Found ${seasonDirectoryUrls.length} quality directories for S${seasonNumber}`
      );

      for (const dir of seasonDirectoryUrls) {
        try {
          this.logger.debug(`Fetching episode list from directory: ${dir.url}`);

          // --- شروع تغییر: اضافه کردن User-Agent ---
          // این کار از بلاک شدن توسط سرورهای دانلود جلوگیری می‌کند
          const dirRes = await Axios.get(dir.url, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            },
          });
          // --- پایان تغییر ---

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
            // اما این چک برای اطمینان در صورتی که لینک نسبی (relative) بود، باقی می‌ماند
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
   */
  async getLinks(type, imdbId, movieData) {
    if (!movieData) {
      this.logger.error("getLinks called with no movieData.");
      return [];
    }

    if (type === "movie") {
      return this.getMovieLinks(movieData);
    }
    if (type === "series") {
      return await this.getSeriesLinks(movieData, imdbId);
    }
    return [];
  }
}
