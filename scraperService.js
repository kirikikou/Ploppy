const config = require('../config');

const moduleId = Math.random().toString(36).substring(2, 10);
config.smartLog('service', `Loading scraperService.js (ID: ${moduleId}) at ${new Date().toISOString()}`);

const StepBasedScraper = require('./StepBasedScraper');
const ProgressiveScraper = require('./progressiveScraper');
const AdaptiveScraper = require('./adaptiveScraper');
const RobustScraper = require('./robustScraper');
const UnifiedScrapingService = require('./unifiedScrapingService');
const { getCachedData, saveCache } = require('../cacheManager');
const { randomDelay } = require('../utils');
const dictionaries = require('../dictionaries');

config.smartLog('service', `StepBasedScraper imported successfully from ${require.resolve('./StepBasedScraper')}`);

const stepBasedScraper = new StepBasedScraper();
const progressiveScraper = new ProgressiveScraper();
const adaptiveScraper = new AdaptiveScraper();
const unifiedScrapingService = new UnifiedScrapingService();
let robustScraper = null;

async function scrapeCareerPage(url, options = {}) {
  config.smartLog('service', `Starting scrape process for: ${url}`);
  config.smartLog('service', `scrapeCareerPage called from module instance ${moduleId}`);
  config.smartLog('service', `DEBUG: StepBasedScraper exists: ${!!stepBasedScraper}`); 
  
  const enrichedOptions = enrichOptionsWithDictionaries(options, url);
  
  try {
    const cachedData = await getCachedData(url);
    if (cachedData) {
      config.smartLog('service', `Using cached data for ${url} (less than 24h old)`);
      return cachedData;
    }
    config.smartLog('service', `No valid cache found for ${url}, proceeding with scrape`);
  } catch (error) {
    config.smartLog('fail', `Error checking cache for ${url}: ${error.message}`);
  }
  
  try {
    config.smartLog('service', `Attempting scrape with UnifiedScrapingService for ${url}`);
    const pageData = await unifiedScrapingService.scrape(url, enrichedOptions);
    
    if (pageData && isScrapedDataValid(pageData)) {
      config.smartLog('service', `UnifiedScrapingService successful for ${url} with method: ${pageData.method}`);
      await saveCache(url, pageData);
      return pageData;
    } else {
      config.smartLog('service', `UnifiedScrapingService failed for ${url}, trying legacy scrapers`);
    }
  } catch (error) {
    config.smartLog('fail', `Error with UnifiedScrapingService for ${url}: ${error.message}`);
  }
  
  let pageData = null;
  try {
    config.smartLog('service', `Attempting scrape with StepBasedScraper for ${url}`);
    pageData = await stepBasedScraper.scrape(url, enrichedOptions);
    
    if (pageData && isScrapedDataValid(pageData)) {
      config.smartLog('service', `StepBasedScraper successful for ${url} with method: ${pageData.method}`);
      await saveCache(url, pageData);
      return pageData;
    } else {
      config.smartLog('service', `StepBasedScraper failed for ${url}, trying fallback scrapers`);
      pageData = null;
    }
  } catch (error) {
    config.smartLog('fail', `Error with StepBasedScraper for ${url}: ${error.message}`);
    pageData = null;
  }
  
  if (!pageData) {
    try {
      config.smartLog('service', `Attempting fallback with ProgressiveScraper for ${url}`);
      pageData = await progressiveScraper.scrape(url, enrichedOptions);
      
      if (pageData && isScrapedDataValid(pageData)) {
        config.smartLog('service', `ProgressiveScraper fallback successful for ${url}`);
        await saveCache(url, pageData);
        return pageData;
      } else {
        config.smartLog('service', `ProgressiveScraper failed for ${url}`);
        pageData = null;
      }
    } catch (error) {
      config.smartLog('fail', `Error with ProgressiveScraper for ${url}: ${error.message}`);
      pageData = null;
    }
  }
  
  if (!pageData) {
    try {
      config.smartLog('service', `Attempting fallback with AdaptiveScraper for ${url}`);
      pageData = await adaptiveScraper.scrape(url);
      
      if (pageData && isScrapedDataValid(pageData)) {
        config.smartLog('service', `AdaptiveScraper fallback successful for ${url}`);
        await saveCache(url, pageData);
        return pageData;
      } else {
        config.smartLog('service', `AdaptiveScraper failed or returned invalid data for ${url}`);
        pageData = null;
      }
    } catch (error) {
      config.smartLog('fail', `Error with AdaptiveScraper for ${url}: ${error.message}`);
      pageData = null;
    }
  }
  
  if (!pageData) {
    try {
      if (!robustScraper) {
        robustScraper = new RobustScraper();
        await robustScraper.initialize();
      }
      
      config.smartLog('service', `Attempting last resort with RobustScraper for ${url}`);
      pageData = await robustScraper.scrapeCareerPage(url, enrichedOptions);
      
      if (pageData && isScrapedDataValid(pageData)) {
        config.smartLog('service', `RobustScraper successful as last resort for ${url}`);
        await saveCache(url, pageData);
        return pageData;
      } else {
        config.smartLog('service', `All scrapers failed for ${url}`);
      }
    } catch (error) {
      config.smartLog('fail', `Error with RobustScraper for ${url}: ${error.message}`);
    }
  }
  
  return pageData;
}

function enrichOptionsWithDictionaries(options, url) {
  const enriched = { ...options };
  
  if (!enriched.jobTerms) {
    enriched.jobTerms = dictionaries.jobTerms;
  }
  
  if (!enriched.knownJobPlatforms) {
    enriched.knownJobPlatforms = dictionaries.knownJobPlatforms;
  }
  
  if (!enriched.complexDomains) {
    enriched.complexDomains = dictionaries.complexDomains;
  }
  
  if (!enriched.cookieSelectors) {
    enriched.cookieSelectors = dictionaries.cookieSelectors;
  }
  
  if (!enriched.showMoreSelectors) {
    enriched.showMoreSelectors = dictionaries.showMoreSelectors;
  }
  
  if (!enriched.paginationSelectors) {
    enriched.paginationSelectors = dictionaries.paginationSelectors;
  }
  
  if (!enriched.jobNavigationSelectors) {
    enriched.jobNavigationSelectors = dictionaries.jobNavigationSelectors;
  }
  
  if (!enriched.jobListingSelectors) {
    enriched.jobListingSelectors = dictionaries.jobListingSelectors;
  }
  
  if (!enriched.jobURLPatterns) {
    enriched.jobURLPatterns = dictionaries.jobURLPatterns;
  }
  
  if (!enriched.buttonPatterns) {
    enriched.buttonPatterns = dictionaries.buttonPatterns;
  }
  
  if (!enriched.loadingIndicators) {
    enriched.loadingIndicators = dictionaries.loadingIndicators;
  }
  
  if (!enriched.errorSelectors) {
    enriched.errorSelectors = dictionaries.errorSelectors;
  }
  
  if (!enriched.dynamicContentIndicators) {
    enriched.dynamicContentIndicators = dictionaries.dynamicContentIndicators;
  }
  
  if (!enriched.showMorePatterns) {
    enriched.showMorePatterns = dictionaries.showMorePatterns;
  }
  
  if (!enriched.paginationPatterns) {
    enriched.paginationPatterns = dictionaries.paginationPatterns;
  }
  
  if (!enriched.blockingContentSelectors) {
    enriched.blockingContentSelectors = dictionaries.blockingContentSelectors;
  }
  
  if (!enriched.emptyContentIndicators) {
    enriched.emptyContentIndicators = dictionaries.emptyContentIndicators;
  }
  
  if (!enriched.searchFilterSelectors) {
    enriched.searchFilterSelectors = dictionaries.searchFilterSelectors;
  }
  
  if (!enriched.jobDetailURLPatterns) {
    enriched.jobDetailURLPatterns = dictionaries.jobDetailURLPatterns;
  }
  
  enriched.isComplexDomain = dictionaries.complexDomains.some(domain => url.includes(domain));
  enriched.detectedPlatform = detectJobPlatform(url);
  
  return enriched;
}

function detectJobPlatform(url) {
  const knownJobPlatforms = dictionaries.knownJobPlatforms;
  for (const platform of knownJobPlatforms) {
    if (platform.patterns.some(pattern => url.includes(pattern))) {
      return platform;
    }
  }
  return null;
}

function isScrapedDataValid(data) {
  if (!data) return false;
  
  if (!data.url || !data.scrapedAt) return false;
  
  if (!data.text || data.text.length < 50) return false;
  
  if (!data.links || !Array.isArray(data.links) || data.links.length === 0) return false;
  
  return true;
}

async function closeBrowsers() {
  try {
    if (unifiedScrapingService) {
      await unifiedScrapingService.close().catch(e => config.smartLog('fail', `Error closing UnifiedScrapingService: ${e.message}`));
    }
    
    if (stepBasedScraper) {
      await stepBasedScraper.close().catch(e => config.smartLog('fail', `Error closing StepBasedScraper: ${e.message}`));
    }
    
    if (progressiveScraper) {
      await progressiveScraper.close().catch(e => config.smartLog('fail', `Error closing ProgressiveScraper: ${e.message}`));
    }
    
    if (robustScraper) {
      await robustScraper.close().catch(e => config.smartLog('fail', `Error closing RobustScraper: ${e.message}`));
    }
  } catch (error) {
    config.smartLog('fail', `Error closing browsers: ${error.message}`);
  }
}

function findJobMatches(pageData, jobTitles, locations = []) {
  if (!pageData || !pageData.text) {
    return { jobTitles: [], locations: [], links: [], priority: 0 };
  }
  
  const pageTextLower = pageData.text.toLowerCase();
  const pageTitleLower = (pageData.title || '').toLowerCase();
  
  const matches = {
    jobTitles: [],
    locations: [],
    links: [],
    priority: 0
  };
  
  for (const jobTitle of jobTitles) {
    const jobTitleLower = jobTitle.toLowerCase();
    const jobTitleWords = jobTitleLower.split(/\s+/);
    
    const allWordsPresent = jobTitleWords.every(word => 
      word.length > 2 && pageTextLower.includes(word)
    );
    
    const exactMatch = pageTextLower.includes(jobTitleLower) || 
                       pageTitleLower.includes(jobTitleLower);
    
    if (exactMatch || allWordsPresent) {
      matches.jobTitles.push(jobTitle);
      
      const jobLinks = pageData.links.filter(link => {
        if (!link.text && !link.url) return false;
        
        const linkTextLower = (link.text || '').toLowerCase();
        const linkUrlLower = link.url.toLowerCase();
        
        if (linkTextLower.includes(jobTitleLower)) return true;
        
        if (linkUrlLower.includes(jobTitleLower.replace(/\s+/g, '-')) ||
            linkUrlLower.includes(jobTitleLower.replace(/\s+/g, '_')) ||
            linkUrlLower.includes(jobTitleLower.replace(/\s+/g, '+'))) {
          return true;
        }
        
        if (isJobDetailURL(link.url)) {
          return true;
        }
        
        const allWordsInLink = jobTitleWords
          .filter(word => word.length > 2)
          .every(word => linkTextLower.includes(word));
          
        return allWordsInLink;
      });
      
      const enhancedLinks = jobLinks.map(link => ({
        ...link,
        isJobPosting: link.isJobPosting !== undefined ? link.isJobPosting : true,
        isJobDetail: isJobDetailURL(link.url)
      }));
      
      matches.links.push(...enhancedLinks);
    }
  }
  
  if (matches.jobTitles.length > 0) {
    matches.priority = 1;
    
    if (locations && locations.length > 0) {
      for (const location of locations) {
        const locationLower = location.toLowerCase();
        
        if (pageTextLower.includes(locationLower) || pageTitleLower.includes(locationLower)) {
          matches.locations.push(location);
          
          const locationLinks = matches.links.filter(link => {
            const linkTextLower = (link.text || '').toLowerCase();
            return linkTextLower.includes(locationLower);
          });
          
          if (locationLinks.length > 0) {
            matches.priority = 2;
          }
        }
      }
    }
  }
  
  const uniqueLinks = [];
  const seenUrls = new Set();
  
  for (const link of matches.links) {
    if (!seenUrls.has(link.url)) {
      seenUrls.add(link.url);
      uniqueLinks.push(link);
    }
  }
  
  matches.links = uniqueLinks;
  
  return matches;
}

function isJobDetailURL(url) {
  const jobDetailURLPatterns = dictionaries.jobDetailURLPatterns;
  return jobDetailURLPatterns.some(pattern => pattern.test(url));
}

function isJobURL(url) {
  const jobURLPatterns = dictionaries.jobURLPatterns;
  return jobURLPatterns.some(pattern => pattern.test(url));
}

function hasJobTerms(text) {
  if (!text) return false;
  const textLower = text.toLowerCase();
  const jobTerms = dictionaries.jobTerms;
  return jobTerms.some(term => textLower.includes(term.toLowerCase()));
}

module.exports = {
  scrapeCareerPage,
  findJobMatches,
  closeBrowsers,
  detectJobPlatform,
  isJobDetailURL,
  isJobURL,
  hasJobTerms
};