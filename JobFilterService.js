const path = require('path');
const fs = require('fs').promises;
const dictionaries = require('../dictionaries');
const config = require('../config');

class JobFilterService {
  constructor() {
    this.cacheDir = path.join(__dirname, '../cache');
  }

  async filterCachedResults(companies, jobTitles, locations = [], options = {}) {
    config.smartLog('cache', `Filtering cached results for ${companies.length} companies with job titles: ${jobTitles.join(', ')}`);
    
    const results = [];
    const cacheStatus = {
      foundInCache: [],
      needsRefresh: [],
      notFound: []
    };

    for (const company of companies) {
      try {
        const cacheResult = await this.checkCompanyCache(company, jobTitles, locations, options);
        
        if (cacheResult.status === 'found') {
          results.push(cacheResult.data);
          cacheStatus.foundInCache.push(company);
        } else if (cacheResult.status === 'expired') {
          cacheStatus.needsRefresh.push(company);
        } else {
          cacheStatus.notFound.push(company);
        }
      } catch (error) {
        config.smartLog('fail', `Error processing cache for ${company.name}: ${error.message}`);
        cacheStatus.notFound.push(company);
      }
    }

    return {
      results,
      cacheStatus,
      summary: {
        totalCompanies: companies.length,
        foundInCache: cacheStatus.foundInCache.length,
        needsRefresh: cacheStatus.needsRefresh.length,
        notFound: cacheStatus.notFound.length
      }
    };
  }

  async checkCompanyCache(company, jobTitles, locations, options) {
    const cacheKey = this.generateCacheKey(company.website || company.name);
    const cacheFile = path.join(this.cacheDir, `${cacheKey}.json`);

    try {
      const stats = await fs.stat(cacheFile);
      const cacheAge = Date.now() - stats.mtime.getTime();
      const maxAge = options.maxCacheAge || (24 * 60 * 60 * 1000);

      if (cacheAge > maxAge) {
        config.smartLog('cache', `Cache expired for ${company.name} (${Math.round(cacheAge / 1000 / 60 / 60)}h old)`);
        return { status: 'expired', company };
      }

      const cacheData = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      
      if (!this.isValidCacheData(cacheData)) {
        config.smartLog('fail', `Invalid cache data for ${company.name}`);
        return { status: 'expired', company };
      }

      const filteredData = this.applyJobFilters(cacheData, jobTitles, locations, options);
      
      config.smartLog('cache', `Found ${filteredData.jobTitles.length} matches in cache for ${company.name}`);
      
      return {
        status: 'found',
        data: {
          company,
          matches: filteredData,
          source: 'cache',
          scrapedAt: cacheData.scrapedAt,
          cacheAge: Math.round(cacheAge / 1000 / 60 / 60)
        }
      };

    } catch (error) {
      if (error.code === 'ENOENT') {
        config.smartLog('cache', `No cache found for ${company.name}`);
        return { status: 'not_found', company };
      }
      throw error;
    }
  }

  applyJobFilters(pageData, jobTitles, locations, options = {}) {
    if (!pageData || !pageData.text) {
      return { jobTitles: [], locations: [], links: [], priority: 0, pageInfo: null };
    }

    config.smartLog('steps', `Applying filters to page data (${pageData.text.length} chars) for terms: ${jobTitles.join(', ')}`);

    const pageTextLower = pageData.text.toLowerCase();
    const pageTitleLower = (pageData.title || '').toLowerCase();
    
    const matches = {
      jobTitles: [],
      locations: [],
      links: [],
      priority: 0,
      pageInfo: {
        pageType: pageData.pageType,
        platform: pageData.platform,
        hasJobListings: pageData.hasJobListings || false
      }
    };

    const strictMode = options.strictMode !== false;
    const minWordLength = options.minWordLength || 2;

    for (const jobTitle of jobTitles) {
      const jobTitleLower = jobTitle.toLowerCase().trim();
      const jobTitleWords = jobTitleLower.split(/\s+/).filter(word => word.length > minWordLength);
      
      if (jobTitleWords.length === 0) continue;

      let hasValidMatch = false;
      let matchType = null;
      let matchingLinks = [];

      const exactMatch = pageTextLower.includes(jobTitleLower) || pageTitleLower.includes(jobTitleLower);
      
      if (exactMatch) {
        hasValidMatch = true;
        matchType = 'exact';
        config.smartLog('win', `Exact match found for "${jobTitle}"`);
      }
      
      else if (jobTitleWords.length >= 2) {
        const allWordsPresent = jobTitleWords.every(word => 
          pageTextLower.includes(word) || pageTitleLower.includes(word)
        );
        
        if (allWordsPresent) {
          const hasProximityMatch = this.checkProximity(pageTextLower, jobTitleWords, 50) ||
                                   this.checkProximity(pageTitleLower, jobTitleWords, 30);
          
          if (hasProximityMatch || !strictMode) {
            hasValidMatch = true;
            matchType = hasProximityMatch ? 'proximity' : 'partial';
            config.smartLog('win', `${matchType} match found for "${jobTitle}"`);
          }
        }
      }
      
      else if (jobTitleWords.length === 1) {
        const singleWord = jobTitleWords[0];
        const wordBoundaryRegex = new RegExp(`\\b${singleWord}\\b`, 'i');
        
        if (wordBoundaryRegex.test(pageTextLower) || wordBoundaryRegex.test(pageTitleLower)) {
          const hasJobContext = this.checkJobContext(pageTextLower, singleWord) ||
                                this.checkJobContext(pageTitleLower, singleWord);
          
          if (hasJobContext || !strictMode) {
            hasValidMatch = true;
            matchType = hasJobContext ? 'contextual' : 'isolated';
            config.smartLog('win', `${matchType} match found for "${jobTitle}"`);
          }
        }
      }

      if (hasValidMatch) {
        matches.jobTitles.push(jobTitle);
        
        const relevantLinks = this.filterRelevantLinks(pageData.links, jobTitle, jobTitleWords, strictMode);
        matchingLinks = relevantLinks.map(link => ({
          ...link,
          matchedJobTitle: jobTitle,
          matchType: matchType,
          matchConfidence: this.calculateMatchConfidence(matchType, relevantLinks.length)
        }));

        matches.links.push(...matchingLinks);
        
        config.smartLog('steps', `Found ${matchingLinks.length} relevant links for "${jobTitle}"`);
      } else {
        config.smartLog('steps', `No valid match found for "${jobTitle}"`);
      }
    }

    matches.links = this.deduplicateAndSortLinks(matches.links);
    
    if (matches.jobTitles.length > 0) {
      matches.priority = this.calculatePriority(matches, pageData);
    }

    if (locations && locations.length > 0) {
      this.applyLocationFilter(matches, pageTextLower, pageTitleLower, locations);
    }

    config.smartLog('win', `Filter results: ${matches.jobTitles.length} job title matches, ${matches.links.length} relevant links`);
    
    return matches;
  }

  checkProximity(text, words, maxDistance) {
    for (let i = 0; i < words.length - 1; i++) {
      const word1 = words[i];
      const word2 = words[i + 1];
      
      const proximityRegex = new RegExp(`\\b${word1}\\b[\\s\\w]{0,${maxDistance}}\\b${word2}\\b`, 'i');
      if (proximityRegex.test(text)) {
        return true;
      }
    }
    
    if (words.length === 2) {
      const reverseRegex = new RegExp(`\\b${words[1]}\\b[\\s\\w]{0,${maxDistance}}\\b${words[0]}\\b`, 'i');
      return reverseRegex.test(text);
    }
    
    return false;
  }

  checkJobContext(text, word) {
    const contextPatterns = [
      `(?:job|position|role|poste|emploi|trabajo|stelle|lavoro)[\\s\\w]{0,30}\\b${word}\\b`,
      `\\b${word}\\b[\\s\\w]{0,30}(?:job|position|role|poste|emploi|trabajo|stelle|lavoro)`,
      `(?:senior|junior|lead|manager|director|chef|responsable)[\\s\\w]{0,20}\\b${word}\\b`,
      `\\b${word}\\b[\\s\\w]{0,20}(?:engineer|developer|analyst|specialist|expert|consultant)`
    ];
    
    return contextPatterns.some(pattern => new RegExp(pattern, 'i').test(text));
  }

  filterRelevantLinks(links, jobTitle, jobTitleWords, strictMode) {
    if (!links || !Array.isArray(links)) return [];

    const jobTitleLower = jobTitle.toLowerCase();
    
    return links.filter(link => {
      if (!link.text || !link.url) return false;
      
      const linkTextLower = link.text.toLowerCase();
      const linkUrlLower = link.url.toLowerCase();
      
      const isGenericLink = /^(apply|view|see|more|details|info|learn|about|contact|home|start|cookie|policy|privacy|login|register|postuler|voir|détails|aplicar|ver|bewerben|candidarsi)$/i.test(link.text.trim());
      
      if (isGenericLink) return false;
      
      if (linkTextLower.includes(jobTitleLower)) return true;
      
      const urlVariations = [
        jobTitleLower.replace(/\s+/g, '-'),
        jobTitleLower.replace(/\s+/g, '_'),
        jobTitleLower.replace(/\s+/g, '+')
      ];
      
      if (urlVariations.some(variation => linkUrlLower.includes(variation))) return true;
      
      if (jobTitleWords.length >= 2) {
        const wordsInLink = jobTitleWords.filter(word => linkTextLower.includes(word));
        const wordMatchRatio = wordsInLink.length / jobTitleWords.length;
        
        if (wordMatchRatio >= 0.7) {
          return true;
        }
      }
      
      if (link.linkType === 'job_posting' || link.linkType === 'job_listing') {
        if (jobTitleWords.some(word => linkTextLower.includes(word))) {
          return true;
        }
      }
      
      return false;
    });
  }

  calculateMatchConfidence(matchType, linksCount) {
    const baseConfidence = {
      'exact': 0.9,
      'proximity': 0.7,
      'contextual': 0.6,
      'partial': 0.5,
      'isolated': 0.3
    };
    
    const confidence = baseConfidence[matchType] || 0.3;
    const linkBonus = Math.min(linksCount * 0.05, 0.1);
    
    return Math.min(confidence + linkBonus, 1.0);
  }

  calculatePriority(matches, pageData) {
    let priority = matches.jobTitles.length * 0.5;
    
    if (pageData.platform) priority += 0.3;
    if (pageData.hasJobListings) priority += 0.2;
    if (matches.links.length > 0) priority += 0.2;
    
    return priority;
  }

  applyLocationFilter(matches, pageTextLower, pageTitleLower, locations) {
    for (const location of locations) {
      const locationLower = location.toLowerCase();
      
      if (pageTextLower.includes(locationLower) || pageTitleLower.includes(locationLower)) {
        matches.locations.push(location);
        matches.priority += 0.2;
      }
    }
  }

  deduplicateAndSortLinks(links) {
    const uniqueLinks = [];
    const seenUrls = new Set();
    
    for (const link of links) {
      if (!seenUrls.has(link.url)) {
        seenUrls.add(link.url);
        uniqueLinks.push(link);
      }
    }
    
    return uniqueLinks.sort((a, b) => {
      const confidenceOrder = { 'high': 3, 'medium': 2, 'low': 1 };
      return (confidenceOrder[b.matchConfidence] || 0) - (confidenceOrder[a.matchConfidence] || 0);
    });
  }

  isValidCacheData(data) {
    return data && 
           data.url && 
           data.text && 
           data.text.length > 50 && 
           Array.isArray(data.links) && 
           data.scrapedAt;
  }

  generateCacheKey(input) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(input.toLowerCase()).digest('hex');
  }
}

module.exports = JobFilterService;