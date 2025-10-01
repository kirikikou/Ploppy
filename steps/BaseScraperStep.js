const config = require('../../config');

class BaseScraperStep {
  constructor(name, priority = 0) {
    this.name = name;
    this.priority = priority;
    this.dictionary = null;
  }

  async initialize(page = null) {
  }

  setDictionary(dictionary) {
    this.dictionary = dictionary;
    config.smartLog('langue', `Dictionary injected for step ${this.name}: ${dictionary.getCurrentLanguage()}`);
  }

  getDictionary() {
    if (!this.dictionary) {
      throw new Error(`Dictionary not injected for step ${this.name}. Use setDictionary() before scraping.`);
    }
    return this.dictionary;
  }

  async isApplicable(url, prevStepResult = {}) {
    return true;
  }

  async scrape(url, options = {}) {
    if (options.dictionary) {
      this.setDictionary(options.dictionary);
    }
    
    if (!this.dictionary) {
      throw new Error(`Step ${this.name} requires dictionary injection via options.dictionary or setDictionary()`);
    }
    
    throw new Error(`Method scrape() must be implemented by subclass (${this.name})`);
  }

  isJobRelatedURL(url) {
    const dict = this.getDictionary();
    const jobURLPatterns = dict.getJobURLPatterns();
    const jobDetailURLPatterns = dict.getJobDetailURLPatterns();
    return jobURLPatterns.some(pattern => pattern.test(url)) ||
           jobDetailURLPatterns.some(pattern => pattern.test(url));
  }

  detectJobPlatform(url, html = '') {
    const dict = this.getDictionary();
    const knownJobPlatforms = dict.getKnownJobPlatforms();
    return knownJobPlatforms.find(platform => 
      platform.patterns.some(pattern => url.includes(pattern)) ||
      platform.indicators.some(indicator => html.includes(indicator))
    );
  }

  isComplexDomain(url) {
    const domain = new URL(url).hostname.toLowerCase();
    const dict = this.getDictionary();
    const complexDomains = dict.getComplexDomains();
    return complexDomains.some(complexDomain => domain.includes(complexDomain));
  }

  hasJobTerms(text) {
    const lowerText = text.toLowerCase();
    const dict = this.getDictionary();
    const jobTerms = dict.getJobTerms();
    return jobTerms.some(term => lowerText.includes(term.toLowerCase()));
  }

  countJobTerms(text) {
    const lowerText = text.toLowerCase();
    const dict = this.getDictionary();
    const jobTerms = dict.getJobTerms();
    return jobTerms.filter(term => lowerText.includes(term.toLowerCase())).length;
  }

  hasBlockingContent(html) {
    const dict = this.getDictionary();
    const blockingSelectors = dict.getBlockingContentSelectors();
    const blockingTextSelectors = dict.getBlockingTextSelectors();
    
    const lowerHtml = html.toLowerCase();
    
    const hasBlockingText = blockingTextSelectors.some(text => 
      lowerHtml.includes(text.toLowerCase())
    );
    
    const hasBlockingElements = blockingSelectors.some(selector => {
      try {
        return html.includes(selector.replace(/^[#.]/, ''));
      } catch {
        return false;
      }
    });
    
    return hasBlockingText || hasBlockingElements;
  }

  hasEmptyContent(html) {
    const dict = this.getDictionary();
    const emptyContentSelectors = dict.getEmptyContentTextSelectors();
    const lowerHtml = html.toLowerCase();
    return emptyContentSelectors.some(text => lowerHtml.includes(text.toLowerCase()));
  }

  isDynamicContent(html) {
    const dict = this.getDictionary();
    const dynamicContentIndicators = dict.getDynamicContentIndicators();
    return dynamicContentIndicators.some(selector => {
      try {
        return html.includes(selector.replace(/^[#.]/, '').replace(/[[\]:]/g, ''));
      } catch {
        return false;
      }
    });
  }

  extractJobLinks(html, baseUrl) {
    const links = [];
    const urlObj = new URL(baseUrl);
    const baseOrigin = urlObj.origin;
    
    const linkRegex = /href=["']([^"']+)["']/gi;
    let match;
    
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      if (this.isJobRelatedURL(href)) {
        try {
          const fullUrl = href.startsWith('http') ? href : new URL(href, baseOrigin).href;
          links.push(fullUrl);
        } catch {}
      }
    }
    
    return [...new Set(links)];
  }

  calculateJobRelevanceScore(text, url) {
    let score = 0;
    
    const lowerText = text.toLowerCase();
    const lowerUrl = url.toLowerCase();
    
    if (this.isJobRelatedURL(url)) score += 30;
    
    const dict = this.getDictionary();
    const navigationTerms = dict.getJobNavigationTextSelectors();
    const hasCareerTerms = navigationTerms.some(term => 
      lowerUrl.includes(term.toLowerCase())
    );
    if (hasCareerTerms) score += 25;
    
    const jobTermCount = this.countJobTerms(text);
    if (jobTermCount > 0) score += Math.min(jobTermCount * 5, 30);
    
    const platform = this.detectJobPlatform(url, text);
    if (platform) score += 20;
    
    const jobTerms = dict.getJobTerms();
    const careerMatches = jobTerms.filter(term => lowerText.includes(term.toLowerCase())).length;
    if (careerMatches > 0) score += Math.min(careerMatches * 3, 20);
    
    const textLength = text.length;
    if (textLength > 500) score += 10;
    if (textLength > 2000) score += 10;
    
    return Math.min(score, 100);
  }

  isResultValid(result) {
    if (!result) return false;
    
    if (!result.url || !result.text || !result.links || !Array.isArray(result.links)) {
      return false;
    }
    
    if (result.text.length < 100) return false;
    
    if (result.links.length === 0) return false;
    
    if (this.hasBlockingContent(result.text)) {
      config.smartLog('fail', `Blocking content detected for ${result.url}`);
      return false;
    }
    
    return true;
  }

  getCookieSelectors() {
    const dict = this.getDictionary();
    return dict.getCookieSelectors();
  }

  getShowMoreSelectors() {
    const dict = this.getDictionary();
    return dict.getShowMoreSelectors();
  }

  getPaginationSelectors() {
    const dict = this.getDictionary();
    return dict.getPaginationSelectors();
  }

  getJobListingSelectors() {
    const dict = this.getDictionary();
    return dict.getJobListingSelectors();
  }

  getJobNavigationSelectors() {
    const dict = this.getDictionary();
    return dict.getJobNavigationSelectors();
  }

  getLoadingIndicators() {
    const dict = this.getDictionary();
    return dict.getLoadingIndicators();
  }

  getErrorSelectors() {
    const dict = this.getDictionary();
    return dict.getErrorSelectors();
  }

  getShowMoreTextSelectors() {
    const dict = this.getDictionary();
    return dict.getShowMoreTextSelectors();
  }

  getCookieTextSelectors() {
    const dict = this.getDictionary();
    return dict.getCookieTextSelectors();
  }

  getJobTerms() {
    const dict = this.getDictionary();
    return dict.getJobTerms();
  }

  getJobURLPatterns() {
    const dict = this.getDictionary();
    return dict.getJobURLPatterns();
  }

  getJobDetailURLPatterns() {
    const dict = this.getDictionary();
    return dict.getJobDetailURLPatterns();
  }

  getDynamicContentIndicators() {
    const dict = this.getDictionary();
    return dict.getDynamicContentIndicators();
  }

  getSearchFilterSelectors() {
    const dict = this.getDictionary();
    return dict.getSearchFilterSelectors();
  }

  getFilterTextSelectors() {
    const dict = this.getDictionary();
    return dict.getFilterTextSelectors();
  }

  getFilterKeywords() {
    const dict = this.getDictionary();
    return dict.getFilterKeywords();
  }

  getButtonPatterns() {
    const dict = this.getDictionary();
    return dict.getButtonPatterns();
  }

  getDynamicContentZones() {
    const dict = this.getDictionary();
    return dict.dynamicContentZones;
  }

  getPaginationTextSelectors() {
    const dict = this.getDictionary();
    return dict.getPaginationTextSelectors();
  }

  getJobNavigationTextSelectors() {
    const dict = this.getDictionary();
    return dict.getJobNavigationTextSelectors();
  }

  getLoadingTextSelectors() {
    const dict = this.getDictionary();
    return dict.getLoadingTextSelectors();
  }

  getErrorTextSelectors() {
    const dict = this.getDictionary();
    return dict.getErrorTextSelectors();
  }

  getShowMorePatterns() {
    const dict = this.getDictionary();
    return dict.getShowMorePatterns();
  }

  getPaginationPatterns() {
    const dict = this.getDictionary();
    return dict.getPaginationPatterns();
  }

  getBlockingContentSelectors() {
    const dict = this.getDictionary();
    return dict.getBlockingContentSelectors();
  }

  getBlockingTextSelectors() {
    const dict = this.getDictionary();
    return dict.getBlockingTextSelectors();
  }

  getEmptyContentIndicators() {
    const dict = this.getDictionary();
    return dict.getEmptyContentIndicators();
  }

  getEmptyContentTextSelectors() {
    const dict = this.getDictionary();
    return dict.getEmptyContentTextSelectors();
  }

  getTemplateIndicators() {
    const dict = this.getDictionary();
    return dict.getTemplateIndicators();
  }

  getKnownJobPlatforms() {
    const dict = this.getDictionary();
    return dict.getKnownJobPlatforms();
  }

  getComplexDomains() {
    const dict = this.getDictionary();
    return dict.getComplexDomains();
  }

  getPaginationZoneSelectors() {
    const dict = this.getDictionary();
    return dict.paginationZoneSelectors;
  }

  getFilterZoneSelectors() {
    const dict = this.getDictionary();
    return dict.filterZoneSelectors;
  }

  getWorkableSpecificSelectors() {
    const dict = this.getDictionary();
    return dict.getWorkableSpecificSelectors();
  }

  getWorkableDetectionPatterns() {
    const dict = this.getDictionary();
    return dict.getWorkableDetectionPatterns();
  }

  generateJobTitleVariants(jobTitle) {
    const dict = this.getDictionary();
    return dict.generateJobTitleVariants ? dict.generateJobTitleVariants(jobTitle) : [jobTitle];
  }

  getJobTitleMappings() {
    const dict = this.getDictionary();
    return dict.getJobTitleMappings();
  }
}

module.exports = BaseScraperStep;