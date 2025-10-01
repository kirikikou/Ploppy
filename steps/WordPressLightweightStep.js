const axios = require('axios');
const cheerio = require('cheerio');
const BaseScraperStep = require('./BaseScraperStep');
const { getRandomUserAgent } = require('../../utils');
const config = require('../../config');

class WordPressLightweightStep extends BaseScraperStep {
  constructor() {
    super('wordpress-lightweight', 1);
  }
  
  async isApplicable(url, context = {}) {
    if (context.detectedPlatform === 'WordPress') {
      return true;
    }
    
    if (context.htmlContent) {
      const templateIndicators = this.getTemplateIndicators();
      return templateIndicators.some(indicator => 
        context.htmlContent.toLowerCase().includes(indicator.toLowerCase())
      );
    }
    
    return false;
  }
  
  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting ${this.name} for ${url}`);
    
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    let result = null;
    let scrapingError = null;
    
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5,fr;q=0.3,es;q=0.2,de;q=0.1',
          'Accept-Encoding': 'gzip, deflate',
          'Cache-Control': 'no-cache'
        },
        timeout: 15000,
        maxRedirects: 3,
        validateStatus: (status) => status < 500
      });
      
      const $ = cheerio.load(response.data);
      
      if (!this.isWordPressSite($)) {
        config.smartLog('platform', `Not detected as WordPress site`);
        scrapingError = new Error('Not detected as WordPress site');
        return null;
      }
      
      if (this.requiresJavaScript($)) {
        config.smartLog('steps', `Detected JavaScript job content, requires headless`);
        scrapingError = new Error('Requires JavaScript rendering');
        return null;
      }
      
      const content = this.extractBasicContent($, url);
      
      if (this.isContentSufficient(content)) {
        config.smartLog('win', `Successfully extracted content from ${url}`);
        return content;
      }
      
      config.smartLog('fail', `Content insufficient, needs JavaScript rendering`);
      scrapingError = new Error('Content insufficient');
      return null;
      
    } catch (error) {
      config.smartLog('fail', `Error: ${error.message}`);
      scrapingError = error;
      return null;
    }
  }
  
  isWordPressSite($) {
    const templateIndicators = this.getTemplateIndicators();
    const html = $.html().toLowerCase();
    const metaGenerator = $('meta[name="generator"]').attr('content') || '';
    const links = $('link[href*="wp-"]').length;
    const scripts = $('script[src*="wp-"]').length;
    const wpClasses = $('[class*="wp-"]').length;
    
    return templateIndicators.some(indicator => html.includes(indicator.toLowerCase())) ||
           metaGenerator.toLowerCase().includes('wordpress') ||
           links > 0 || scripts > 0 || wpClasses > 0;
  }
  
  requiresJavaScript($) {
    const html = $.html().toLowerCase();
    
    const jsFrameworkIndicators = [
      'vue.js', 'vuejs', 'v-for', 'v-if', '@click',
      'react', 'reactjs', 'jsx',
      'angular', 'ng-', 'ng-repeat', 'ng-if',
      'data-ng-', '[ng-', '{{', '}}',
      'ember.js', 'emberjs',
      'knockout.js', 'data-bind'
    ];
    
    const hasJSFramework = jsFrameworkIndicators.some(indicator => html.includes(indicator));
    
    const dynamicContentIndicators = this.getDynamicContentIndicators();
    const hasDynamicIndicators = dynamicContentIndicators.some(indicator => 
      html.includes(indicator.toLowerCase())
    );
    
    const hasAsyncScripts = $('script[async], script[defer]').length > 0;
    
    const hasEmptyJobContainers = $('[class*="job"], [id*="job"], [class*="career"], [id*="career"]').length > 0 &&
      $('[class*="job"] a, [id*="job"] a, [class*="career"] a, [id*="career"] a').length === 0;
    
    const loadingIndicators = this.getLoadingIndicators();
    const hasLoadingElements = loadingIndicators.some(selector => {
      try {
        return $(selector).length > 0;
      } catch (e) {
        return false;
      }
    });
    
    const bodyText = $('body').text().trim();
    const isContentTooShort = bodyText.length < 500;
    
    const hasJobFiltersWithoutJobs = $('[class*="filter"], [class*="search"]').length > 0 && 
      $('a[href*="job"], a[href*="career"], a[href*="position"]').length === 0;
    
    return hasJSFramework || hasDynamicIndicators || hasAsyncScripts || 
           hasEmptyJobContainers || hasLoadingElements || 
           isContentTooShort || hasJobFiltersWithoutJobs;
  }
  
  extractBasicContent($, url) {
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const links = this.extractSimpleLinks($, url);
    
    return {
      url,
      title: $('title').text().trim(),
      text: bodyText,
      links: links,
      scrapedAt: new Date().toISOString(),
      method: this.name,
      platform: 'WordPress',
      detectedPlatform: 'WordPress'
    };
  }
  
  extractSimpleLinks($, url) {
    const links = [];
    const processedUrls = new Set();
    const jobTerms = this.getJobTerms();
    const jobURLPatterns = this.getJobURLPatterns();
    
    $('a[href]').each((i, element) => {
      const $link = $(element);
      const href = $link.attr('href');
      const text = $link.text().trim();
      
      if (href && text && !href.startsWith('javascript:') && !href.startsWith('#') && !processedUrls.has(href)) {
        const isJobURL = jobURLPatterns.some(pattern => pattern.test(href));
        const hasJobTerms = jobTerms.some(term => 
          text.toLowerCase().includes(term.toLowerCase()) || 
          href.toLowerCase().includes(term.toLowerCase())
        );
        
        if (isJobURL || hasJobTerms) {
          links.push({
            url: this.normalizeUrl(href),
            text: text,
            isJobPosting: true,
            matchedJobTitle: text
          });
          processedUrls.add(href);
        }
      }
    });
    
    return links;
  }
  
  normalizeUrl(url) {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) return url;
    return url;
  }
  
  isContentSufficient(content) {
    if (!content) return false;
    
    const hasJobLinks = content.links && content.links.filter(link => link.isJobPosting).length > 5;
    const hasSubstantialContent = content.text && content.text.length > 1000;
    const hasJobTermsInText = content.text && this.countJobTerms(content.text) > 3;
    
    if (hasJobLinks && hasSubstantialContent && hasJobTermsInText) {
      const jobPostingLinks = content.links.filter(link => link.isJobPosting);
      config.smartLog('win', `Found ${jobPostingLinks.length} job posting links with ${content.text.length} chars`);
      return true;
    }
    
    config.smartLog('steps', `Insufficient content: jobLinks=${content.links?.filter(l => l.isJobPosting).length || 0}, textLength=${content.text?.length || 0}, jobTerms=${this.countJobTerms(content.text)}`);
    return false;
  }
}

module.exports = WordPressLightweightStep;