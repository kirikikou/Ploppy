const BaseScraperStep = require('./BaseScraperStep');
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../../config');
const path = require('path');
const fs = require('fs').promises;

class JazzHRStep extends BaseScraperStep {
  constructor() {
    super('jazzhr-step', 8);
  }

  async isApplicable(url, prevStepResult = {}) {
    if (prevStepResult.detectedPlatform && prevStepResult.detectedPlatform !== 'JazzHR') {
      config.smartLog('platform', `Not applicable: Other platform detected (${prevStepResult.detectedPlatform})`);
      return false;
    }

    const urlLower = url.toLowerCase();
    
    const platforms = this.getKnownJobPlatforms();
    const icimsConfig = platforms.find(p => p.name === 'iCIMS');
    const isICIMSSite = icimsConfig && icimsConfig.patterns.some(pattern => urlLower.includes(pattern));
    if (isICIMSSite) {
      config.smartLog('platform', `Not applicable: iCIMS site detected`);
      return false;
    }
    
    if (prevStepResult.detectedPlatform === 'JazzHR') {
      config.smartLog('platform', `Applicable: Platform detected as JazzHR`);
      return true;
    }
    
    const jazzHRConfig = platforms.find(p => p.name === 'JazzHR');
    if (jazzHRConfig && jazzHRConfig.patterns.some(pattern => urlLower.includes(pattern))) {
      config.smartLog('platform', `Applicable: JazzHR domain detected in URL`);
      return true;
    }
    
    if (prevStepResult.html || prevStepResult.htmlContent) {
      const html = prevStepResult.html || prevStepResult.htmlContent;
      const hasJazzHRIndicators = this.detectJazzHRInContent(html);
      if (hasJazzHRIndicators) {
        config.smartLog('platform', `Applicable: JazzHR indicators found in HTML`);
        return true;
      }
    }
    
    const pathIndicators = jazzHRConfig && jazzHRConfig.apiPatterns ? jazzHRConfig.apiPatterns : ['/apply/jobs', '/public/jobs', '/widget/jobs'];
    const hasJazzHRPath = pathIndicators.some(path => urlLower.includes(path));
    if (hasJazzHRPath) {
      config.smartLog('platform', `Applicable: JazzHR path pattern detected`);
      return true;
    }
    
    return false;
  }

  detectJazzHRInContent(html) {
    const lowerHtml = html.toLowerCase();
    
    const platforms = this.getKnownJobPlatforms();
    const icimsConfig = platforms.find(p => p.name === 'iCIMS');
    if (icimsConfig && icimsConfig.indicators) {
      const hasICIMS = icimsConfig.indicators.some(indicator => lowerHtml.includes(indicator.toLowerCase()));
      if (hasICIMS) {
        config.smartLog('platform', `iCIMS indicators found, not applicable`);
        return false;
      }
    }
    
    const jazzHRConfig = platforms.find(p => p.name === 'JazzHR');
    if (jazzHRConfig && jazzHRConfig.indicators) {
      return jazzHRConfig.indicators.some(indicator => lowerHtml.includes(indicator.toLowerCase()));
    }
    
    return false;
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting JazzHR scraping for ${url}`);
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }

    let result = null;
    let scrapingError = null;
    
    try {
      const startTime = Date.now();
      
      const directResult = await this.tryDirectScraping(url, options);
      if (directResult && this.isValidResult(directResult)) {
        directResult.method = 'jazzhr-direct';
        directResult.executionTime = Date.now() - startTime;
        config.smartLog('win', `Success with direct method in ${directResult.executionTime}ms - ${directResult.links?.length || 0} links`);
        return directResult;
      }
      
      const apiResult = await this.tryJazzHRApiVariants(url, options);
      if (apiResult && this.isValidResult(apiResult)) {
        apiResult.method = 'jazzhr-api';
        apiResult.executionTime = Date.now() - startTime;
        config.smartLog('win', `Success with API method in ${apiResult.executionTime}ms - ${apiResult.links?.length || 0} links`);
        return apiResult;
      }
      
      const widgetResult = await this.tryWidgetScraping(url, options);
      if (widgetResult && this.isValidResult(widgetResult)) {
        widgetResult.method = 'jazzhr-widget';
        widgetResult.executionTime = Date.now() - startTime;
        config.smartLog('win', `Success with widget method in ${widgetResult.executionTime}ms - ${widgetResult.links?.length || 0} links`);
        return widgetResult;
      }
      
      config.smartLog('fail', `All methods failed for ${url}`);
      scrapingError = new Error('All methods failed');
      return null;

    } catch (error) {
      config.smartLog('fail', `Error scraping ${url}: ${error.message}`);
      scrapingError = error;
      
      if (config.shouldExportDebug(result, scrapingError, this.name)) {
        try {
          const debugData = {
            url,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString(),
            methods_attempted: ['direct', 'api', 'widget']
          };
          await fs.writeFile(
            path.join(config.DEBUG_DIR, `${this.name}-FAIL-${new URL(url).hostname}-${Date.now()}.json`),
            JSON.stringify(debugData, null, 2)
          ).catch(() => {});
        } catch (debugError) {}
      }
      
      return null;
    }
  }

  async tryDirectScraping(url, options) {
    try {
      config.smartLog('steps', `Trying direct scraping for ${url}`);
      
      const response = await axios.get(url, {
        timeout: options.timeout || 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });

      if (response.data && response.data.length > 500) {
        const $ = cheerio.load(response.data);
        const result = this.extractFromHTML($, url);
        if (result && this.isValidResult(result)) {
          result.variantType = 'jazzhr-direct';
          return result;
        }
      }
    } catch (error) {
      config.smartLog('retry', `Direct scraping failed: ${error.message}`);
    }

    return null;
  }

  async tryJazzHRApiVariants(url, options) {
    const baseUrl = this.extractBaseUrl(url);
    if (!baseUrl) return null;

    const platforms = this.getKnownJobPlatforms();
    const jazzHRConfig = platforms.find(p => p.name === 'JazzHR');
    const apiEndpoints = jazzHRConfig && jazzHRConfig.apiPatterns ? 
      jazzHRConfig.apiPatterns.map(pattern => `${baseUrl}${pattern}`) :
      [`${baseUrl}/api/jobs`, `${baseUrl}/widget/jobs`, `${baseUrl}/public/jobs`, 
       `${baseUrl}/api/v1/jobs`, `${baseUrl}/jobs.json`, `${baseUrl}/feed.json`];

    for (const apiUrl of apiEndpoints) {
      try {
        config.smartLog('steps', `Trying API endpoint: ${apiUrl}`);
        
        const response = await axios.get(apiUrl, {
          timeout: options.timeout || 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/html, */*',
            'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Referer': url
          }
        });

        if (response.data) {
          let jsonData;
          if (typeof response.data === 'string') {
            if (response.data.trim().startsWith('{') || response.data.trim().startsWith('[')) {
              try {
                jsonData = JSON.parse(response.data);
              } catch {
                continue;
              }
            } else {
              continue;
            }
          } else {
            jsonData = response.data;
          }

          if (jsonData && ((Array.isArray(jsonData) && jsonData.length > 0) || 
                          (jsonData.jobs && Array.isArray(jsonData.jobs) && jsonData.jobs.length > 0) ||
                          (jsonData.data && Array.isArray(jsonData.data) && jsonData.data.length > 0))) {
            const result = this.processJazzHRApiData(jsonData, url);
            if (result) {
              result.variantType = 'jazzhr-api';
              result.apiEndpoint = apiUrl;
              return result;
            }
          }
        }
      } catch (error) {
        config.smartLog('retry', `API endpoint ${apiUrl} failed: ${error.message}`);
        continue;
      }
    }

    return null;
  }

  async tryWidgetScraping(url, options) {
    const baseUrl = this.extractBaseUrl(url);
    if (!baseUrl) return null;

    const widgetUrls = [
      `${baseUrl}/widget`,
      `${baseUrl}/embed`,
      `${baseUrl}/iframe`
    ];

    for (const widgetUrl of widgetUrls) {
      try {
        config.smartLog('steps', `Trying widget URL: ${widgetUrl}`);
        
        const response = await axios.get(widgetUrl, {
          timeout: options.timeout || 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Referer': url
          }
        });

        if (response.data && response.data.length > 200) {
          const $ = cheerio.load(response.data);
          const result = this.extractFromHTML($, widgetUrl);
          if (result) {
            result.variantType = 'jazzhr-widget';
            result.widgetUrl = widgetUrl;
            return result;
          }
        }
      } catch (error) {
        config.smartLog('retry', `Widget URL ${widgetUrl} failed: ${error.message}`);
        continue;
      }
    }

    return null;
  }

  extractFromHTML($, url) {
    const links = [];
    let allText = '';
    const jobTitles = [];
    const jobLinkSelectors = this.getJobListingSelectors();
    const dynamicZones = this.getDynamicContentZones();

    config.smartLog('steps', `Analyzing HTML structure for job extraction`);

    const allSelectors = [...jobLinkSelectors, ...dynamicZones, 'a', 'div', 'p', 'span', 'td', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
    const combinedSelectors = allSelectors.join(', ');

    $(combinedSelectors).each((i, element) => {
      const $element = $(element);
      const tagName = element.tagName ? element.tagName.toLowerCase() : '';
      
      if (tagName === 'a') {
        const href = $element.attr('href');
        const text = $element.text().trim();
        
        if (href && text && text.length > 2 && text.length < 200) {
          const cleanTitle = this.cleanJobTitle(text);
          if (cleanTitle && cleanTitle.length > 2 && !jobTitles.includes(cleanTitle)) {
            const jobUrl = this.resolveUrl(href, url);
            links.push({
              url: jobUrl,
              text: cleanTitle,
              isJobPosting: true,
              linkType: 'job_posting',
              confidence: this.isJobRelatedURL(href) ? 0.9 : 0.6
            });
            jobTitles.push(cleanTitle);
            config.smartLog('win', `Found job link: ${cleanTitle} -> ${jobUrl}`);
          }
        }
      } else {
        const elementText = $element.text().trim();
        if (elementText.length > 5 && elementText.length < 150) {
          const cleanTitle = this.cleanJobTitle(elementText);
          if (cleanTitle && cleanTitle.length > 3 && !jobTitles.includes(cleanTitle) && this.hasJobTerms(cleanTitle)) {
            links.push({
              url: `${url}#job-${i}`,
              text: cleanTitle,
              isJobPosting: true,
              linkType: 'job_posting',
              confidence: 0.5
            });
            jobTitles.push(cleanTitle);
            config.smartLog('win', `Found job text: ${cleanTitle}`);
          }
        }
      }
    });

    const bodyText = this.cleanText($('body').html() || '');
    allText = jobTitles.join(' ') + ' ' + bodyText;

    config.smartLog('steps', `Extraction complete: ${links.length} links, ${jobTitles.length} job titles, text length: ${allText.length}`);

    if (links.length > 0 || this.hasJobTerms(allText)) {
      return {
        url: url,
        title: $('title').text().trim() || this.extractCompanyFromUrl(url),
        text: allText,
        links: links,
        scrapedAt: new Date().toISOString(),
        detectedPlatform: 'JazzHR',
        jobTermsFound: this.countJobTerms(allText),
        isEmpty: false
      };
    }

    return null;
  }

  cleanJobTitle(title) {
    if (!title) return '';
    
    const navigationTerms = this.getJobNavigationTextSelectors();
    const applyPattern = new RegExp(`^(${navigationTerms.join('|')}|Position:|Location:)\\s*`, 'i');
    const applyEndPattern = new RegExp(`\\s+(${navigationTerms.join('|')}|View Details|Learn More|Apply Now)$`, 'i');
    
    return title
      .replace(applyPattern, '')
      .replace(applyEndPattern, '')
      .replace(/^\s*-\s*/, '')
      .replace(/\s*-\s*$/, '')
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  processJazzHRApiData(data, originalUrl) {
    try {
      let jobs = [];
      
      if (Array.isArray(data)) {
        jobs = data;
      } else if (data.jobs && Array.isArray(data.jobs)) {
        jobs = data.jobs;
      } else if (data.data && Array.isArray(data.data)) {
        jobs = data.data;
      } else if (data.positions && Array.isArray(data.positions)) {
        jobs = data.positions;
      }

      if (jobs.length === 0) return null;

      const links = [];
      let allText = '';
      
      for (const job of jobs) {
        const title = job.title || job.name || job.position || job.job_title || 'Job Position';
        const jobId = job.id || job.job_id || job.position_id;
        const location = job.location || job.city || job.office || '';
        const department = job.department || job.team || job.category || '';
        const type = job.type || job.employment_type || job.job_type || '';
        
        let jobUrl = originalUrl;
        if (jobId) {
          const baseUrl = this.extractBaseUrl(originalUrl);
          jobUrl = `${baseUrl}/jobs/${jobId}`;
        } else if (job.url) {
          jobUrl = job.url;
        } else if (job.apply_url) {
          jobUrl = job.apply_url;
        }

        const cleanTitle = this.cleanJobTitle(title);
        if (cleanTitle) {
          links.push({
            url: jobUrl,
            text: cleanTitle,
            isJobPosting: true,
            linkType: 'job_posting',
            confidence: 0.9,
            location: location,
            department: department,
            type: type
          });
          
          allText += `${cleanTitle} `;
          if (location) allText += `${location} `;
          if (department) allText += `${department} `;
          if (type) allText += `${type} `;
          allText += '\n';
        }
      }

      if (links.length > 0) {
        return {
          url: originalUrl,
          title: this.extractCompanyFromUrl(originalUrl),
          text: allText.trim(),
          links: links,
          scrapedAt: new Date().toISOString(),
          detectedPlatform: 'JazzHR',
          jobTermsFound: this.countJobTerms(allText),
          isEmpty: false
        };
      }
    } catch (error) {
      config.smartLog('fail', `Error processing API data: ${error.message}`);
    }

    return null;
  }

  isValidResult(result) {
    if (!result) return false;
    
    const hasContent = result.text && result.text.length >= 50;
    const hasJobContent = this.hasJobTerms(result.text);
    const hasAnyLinks = result.links && result.links.length > 0;
    
    config.smartLog('steps', `Result validation: content(${hasContent}), jobs(${hasJobContent}), links(${hasAnyLinks}), linkCount(${result.links?.length || 0})`);
    
    return hasContent && (hasJobContent || hasAnyLinks);
  }

  extractBaseUrl(url) {
    try {
      const urlObj = new URL(url);
      return `${urlObj.protocol}//${urlObj.hostname}`;
    } catch (error) {
      return null;
    }
  }

  extractCompanyFromUrl(url) {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      const parts = hostname.split('.');
      
      if (parts.length >= 2) {
        return parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + ' Careers';
      }
      
      return 'Career Page';
    } catch (error) {
      return 'Career Page';
    }
  }

  resolveUrl(href, baseUrl) {
    try {
      if (href.startsWith('http')) {
        return href;
      } else if (href.startsWith('/')) {
        const base = this.extractBaseUrl(baseUrl);
        return base + href;
      } else {
        return new URL(href, baseUrl).toString();
      }
    } catch (error) {
      return href;
    }
  }

  cleanText(html) {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  getStepMetadata() {
    return {
      name: this.name,
      description: 'Universal scraper for JazzHR and similar job platforms',
      priority: this.priority,
      platforms: ['JazzHR'],
      methods: ['jazzhr-direct', 'jazzhr-api', 'jazzhr-widget'],
      features: [
        'Dictionary-based detection',
        'Multilingual support', 
        'Universal content extraction',
        'Zero filtering - captures all content',
        'Adaptive to any site structure'
      ]
    };
  }
}

module.exports = JazzHRStep;