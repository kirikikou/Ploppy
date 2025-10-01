const JobFilterService = require('./JobFilterService');
const { scrapeCareerPage } = require('./scraperService');
const EventEmitter = require('events');
const dictionaries = require('../dictionaries');
const config = require('../config');

class SearchOrchestrator extends EventEmitter {
  constructor() {
    super();
    this.jobFilterService = new JobFilterService();
    this.activeSearches = new Map();
  }

  async performSearch(companies, jobTitles, locations = [], options = {}) {
    const searchId = this.generateSearchId(companies, jobTitles, locations);
    config.smartLog('buffer', `Starting search orchestration (ID: ${searchId})`);
    
    const searchOptions = {
      maxCacheAge: options.maxCacheAge || (24 * 60 * 60 * 1000),
      strictMode: options.strictMode !== false,
      enableProgressiveResults: options.enableProgressiveResults !== false,
      timeout: options.timeout || 30000,
      ...options
    };

    const searchResults = {
      searchId,
      immediate: [],
      progressive: [],
      summary: {
        totalCompanies: companies.length,
        completedCount: 0,
        foundInCache: 0,
        scrapedCount: 0,
        errorCount: 0,
        totalMatches: 0
      },
      startTime: Date.now(),
      status: 'running'
    };

    this.emit('searchStarted', { searchId, companies: companies.length, jobTitles });

    try {
      config.smartLog('cache', `Phase 1: Filtering cached results for ${companies.length} companies`);
      const cacheResults = await this.jobFilterService.filterCachedResults(
        companies, 
        jobTitles, 
        locations, 
        searchOptions
      );

      searchResults.immediate = cacheResults.results;
      searchResults.summary.foundInCache = cacheResults.summary.foundInCache;
      searchResults.summary.totalMatches += cacheResults.results.reduce((sum, r) => sum + r.matches.links.length, 0);

      this.emit('immediateResults', {
        searchId,
        results: cacheResults.results,
        summary: cacheResults.summary
      });

      config.smartLog('cache', `Phase 1 complete: ${cacheResults.results.length} immediate results from cache`);

      const companiesNeedingScraping = [
        ...cacheResults.cacheStatus.needsRefresh,
        ...cacheResults.cacheStatus.notFound
      ];

      if (companiesNeedingScraping.length > 0 && searchOptions.enableProgressiveResults) {
        config.smartLog('steps', `Phase 2: Progressive scraping for ${companiesNeedingScraping.length} companies`);
        
        this.emit('scrapingStarted', {
          searchId,
          companiesCount: companiesNeedingScraping.length
        });

        await this.performProgressiveScraping(
          searchId,
          companiesNeedingScraping,
          jobTitles,
          locations,
          searchOptions,
          searchResults
        );
      }

      searchResults.status = 'completed';
      searchResults.endTime = Date.now();
      searchResults.duration = searchResults.endTime - searchResults.startTime;

      this.emit('searchCompleted', {
        searchId,
        summary: searchResults.summary,
        duration: searchResults.duration
      });

      return searchResults;

    } catch (error) {
      config.smartLog('fail', `Search orchestration error for ${searchId}: ${error.message}`);
      searchResults.status = 'error';
      searchResults.error = error.message;
      
      this.emit('searchError', { searchId, error: error.message });
      
      return searchResults;
    }
  }

  async performProgressiveScraping(searchId, companies, jobTitles, locations, options, searchResults) {
    const concurrencyLimit = options.concurrencyLimit || 3;
    const scrapingPromises = [];

    for (let i = 0; i < companies.length; i += concurrencyLimit) {
      const batch = companies.slice(i, i + concurrencyLimit);
      
      const batchPromises = batch.map(async (company) => {
        return this.scrapeAndFilterCompany(
          searchId,
          company,
          jobTitles,
          locations,
          options,
          searchResults
        );
      });

      scrapingPromises.push(...batchPromises);
      
      await Promise.allSettled(batchPromises);
      
      if (i + concurrencyLimit < companies.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    await Promise.allSettled(scrapingPromises);
    config.smartLog('steps', `Progressive scraping completed for search ${searchId}`);
  }

  async scrapeAndFilterCompany(searchId, company, jobTitles, locations, options, searchResults) {
    const companyKey = company.website || company.name;
    
    if (this.activeSearches.has(companyKey)) {
      config.smartLog('buffer', `Skipping ${company.name} - already being scraped`);
      return;
    }

    this.activeSearches.set(companyKey, searchId);

    try {
      config.smartLog('steps', `Scraping ${company.name} (${company.website})`);
      
      this.emit('companyScrapingStarted', {
        searchId,
        company: company.name,
        website: company.website
      });

      const pageData = await scrapeCareerPage(company.website, {
        timeout: options.timeout,
        retries: 1
      });

      if (!pageData || !pageData.text) {
        throw new Error('No valid data retrieved from scraping');
      }

      const filteredResults = this.jobFilterService.applyJobFilters(
        pageData, 
        jobTitles, 
        locations, 
        options
      );

      const result = {
        company,
        matches: filteredResults,
        source: 'scraping',
        scrapedAt: pageData.scrapedAt || new Date().toISOString()
      };

      searchResults.summary.scrapedCount++;
      searchResults.summary.completedCount++;
      searchResults.summary.totalMatches += filteredResults.links.length;
      searchResults.progressive.push(result);

      this.emit('progressiveResult', {
        searchId,
        result,
        progress: {
          completed: searchResults.summary.completedCount,
          total: searchResults.summary.totalCompanies,
          percentage: Math.round((searchResults.summary.completedCount / searchResults.summary.totalCompanies) * 100)
        }
      });

      config.smartLog('win', `Scraping completed for ${company.name}: ${filteredResults.links.length} matches found`);

    } catch (error) {
      config.smartLog('fail', `Scraping error for ${company.name}: ${error.message}`);
      
      searchResults.summary.errorCount++;
      searchResults.summary.completedCount++;

      this.emit('companyScrapingError', {
        searchId,
        company: company.name,
        error: error.message,
        progress: {
          completed: searchResults.summary.completedCount,
          total: searchResults.summary.totalCompanies,
          percentage: Math.round((searchResults.summary.completedCount / searchResults.summary.totalCompanies) * 100)
        }
      });

    } finally {
      this.activeSearches.delete(companyKey);
    }
  }

  async getCachedResultsOnly(companies, jobTitles, locations = [], options = {}) {
    config.smartLog('cache', `Getting cached-only results for ${companies.length} companies`);
    
    return await this.jobFilterService.filterCachedResults(
      companies, 
      jobTitles, 
      locations, 
      { ...options, strictMode: options.strictMode !== false }
    );
  }

  getSearchStatus(searchId) {
    return {
      isActive: this.activeSearches.has(searchId),
      activeCompanies: Array.from(this.activeSearches.keys())
    };
  }

  cancelSearch(searchId) {
    config.smartLog('buffer', `Cancelling search ${searchId}`);
    
    for (const [companyKey, activeSearchId] of this.activeSearches.entries()) {
      if (activeSearchId === searchId) {
        this.activeSearches.delete(companyKey);
      }
    }

    this.emit('searchCancelled', { searchId });
  }

  generateSearchId(companies, jobTitles, locations) {
    const crypto = require('crypto');
    const searchData = {
      companies: companies.map(c => c.name).sort(),
      jobTitles: jobTitles.sort(),
      locations: locations.sort(),
      timestamp: Date.now()
    };
    
    return crypto.createHash('md5')
      .update(JSON.stringify(searchData))
      .digest('hex')
      .substring(0, 8);
  }

  getActiveSearchesCount() {
    return this.activeSearches.size;
  }

  getAllActiveSearches() {
    return Array.from(this.activeSearches.entries());
  }
}

module.exports = SearchOrchestrator;