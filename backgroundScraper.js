const DomainProfiler = require('./DomainProfiler');
const ProfileIndexManager = require('../utils/ProfileIndexManager');
const { scrapeCareerPage } = require('../scrapingService');
const config = require('../config');
const profilingConfig = require('../config/profiling');
const loggingService = require('../services/LoggingService');

class BackgroundScraper {
  constructor() {
    this.domainProfiler = DomainProfiler.getInstance();
    this.indexManager = ProfileIndexManager.getInstance();
    this.isRunning = false;
    this.dailyScheduleId = null;
    this.stats = {
      totalRuns: 0,
      successfulScrapes: 0,
      failedScrapes: 0,
      domainsProcessed: new Set(),
      lastRunAt: null,
      avgScrapesPerRun: 0
    };
  }

  async start() {
    if (this.isRunning) {
      loggingService.log('service', 'Background scraper already running');
      return;
    }

    loggingService.log('service', `Starting background scraper (daily at ${profilingConfig.BACKGROUND_SCRAPER_START_HOUR}:${profilingConfig.BACKGROUND_SCRAPER_START_MINUTE})`);
    this.isRunning = true;

    this.scheduleDailyRun();
    this.checkIfShouldRunNow();
  }

  scheduleDailyRun() {
    const checkInterval = 60 * 1000;

    this.dailyScheduleId = setInterval(async () => {
      this.checkIfShouldRunNow();
    }, checkInterval);

    loggingService.log('service', 'Background scraper daily schedule activated');
  }

  async checkIfShouldRunNow() {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    const targetTime = profilingConfig.BACKGROUND_SCRAPER_START_HOUR * 60 + profilingConfig.BACKGROUND_SCRAPER_START_MINUTE;
    const currentTime = currentHour * 60 + currentMinute;

    if (currentTime === targetTime) {
      loggingService.log('monitoring', 'Background scraper triggered by schedule');
      await this.performBackgroundScraping();
    }
  }

  stop() {
    if (!this.isRunning) {
      loggingService.log('service', 'Background scraper not running');
      return;
    }

    loggingService.log('service', 'Stopping background scraper');
    this.isRunning = false;
    
    if (this.dailyScheduleId) {
      clearInterval(this.dailyScheduleId);
      this.dailyScheduleId = null;
    }
  }

  async performBackgroundScraping() {
    if (!this.isRunning) return;

    const runStartTime = Date.now();
    loggingService.log('scraper', `Background scraping run started at ${new Date().toISOString()}`);

    try {
      this.stats.totalRuns++;
      this.stats.lastRunAt = new Date().toISOString();

      const queueData = await this.indexManager.getBackgroundQueue();
      const domainsToScrape = queueData.queue || [];
      
      if (domainsToScrape.length === 0) {
        loggingService.log('scraper', 'No domains in background scraping queue');
        return;
      }

      loggingService.log('scraper', `Found ${domainsToScrape.length} domains for background scraping`);
      this.logTopDomains(domainsToScrape);

      let successCount = 0;
      let failureCount = 0;

      for (const domainInfo of domainsToScrape) {
        if (!this.isRunning) break;

        try {
          const profile = await this.domainProfiler.loadProfile(domainInfo.url);

          if (!profile) {
            loggingService.log('scraper', `Profile not found for ${domainInfo.url}, skipping`);
            continue;
          }
          
          loggingService.log('scraper', `Background scraping: ${profile.domain} (${domainInfo.hitCount} hits)`);
          
          const scrapingStart = Date.now();
          const result = await scrapeCareerPage(profile.url, {
            useCache: false,
            saveCache: true,
            timeout: 90000,
            backgroundScraping: true
          }, 'background-scraper');

          const scrapingDuration = Date.now() - scrapingStart;

          if (result && result.links && result.links.length > 0) {
            await this.domainProfiler.markBackgroundScrapeCompleted(profile.url, true);
            loggingService.log('win', `Background scrape successful: ${profile.domain} (${result.links.length} jobs, ${scrapingDuration}ms)`);
            
            successCount++;
            this.stats.successfulScrapes++;
            this.stats.domainsProcessed.add(profile.domain);
          } else {
            await this.domainProfiler.markBackgroundScrapeCompleted(profile.url, false);
            loggingService.log('scraper', `Background scrape returned no results: ${profile.domain}`);
            failureCount++;
          }

        } catch (error) {
          loggingService.log('fail', `Background scrape failed: ${domainInfo.id} - ${error.message}`);
          failureCount++;
          this.stats.failedScrapes++;
        }

        await this.delay(2000, 5000);
      }

      const runDuration = Date.now() - runStartTime;
      this.stats.avgScrapesPerRun = Math.round((this.stats.successfulScrapes + this.stats.failedScrapes) / this.stats.totalRuns);

      loggingService.log('timing', `Background scraping completed in ${Math.round(runDuration / 1000)}s`);
      loggingService.log('timing', `Successful: ${successCount}, Failed: ${failureCount}`);
      loggingService.log('timing', `Total stats: ${this.stats.successfulScrapes}/${this.stats.successfulScrapes + this.stats.failedScrapes} successful`);

    } catch (error) {
      loggingService.log('fail', `Background scraping run failed: ${error.message}`);
    }
  }

  logTopDomains(domains) {
    loggingService.log('scraper', 'Top domains for background scraping:');
    domains.slice(0, 10).forEach((domain, index) => {
      loggingService.log('scraper', `${index + 1}. ${domain.id} (${domain.hitCount} hits)`);
    });
  }

  async delay(minMs, maxMs) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      stats: {
        ...this.stats,
        totalUniqueDomainsProcessed: this.stats.domainsProcessed.size
      },
      nextRunAt: `${profilingConfig.BACKGROUND_SCRAPER_START_HOUR}:${String(profilingConfig.BACKGROUND_SCRAPER_START_MINUTE).padStart(2, '0')}`
    };
  }
}

module.exports = BackgroundScraper;