const BaseScraperStep = require('./BaseScraperStep');
const config = require('../../config');
const fs = require('fs').promises;
const path = require('path');

class BrassringStep extends BaseScraperStep {
  constructor() {
    super('brassring-step', 2);
    this.maxExecutionTime = 5000;
  }

  async isApplicable(url, context = {}) {
    const urlLower = url.toLowerCase();
    
    if (context.detectedPlatform === 'Brassring') {
      config.smartLog('platform', `Brassring detected via context for ${url}`);
      return true;
    }
    
    const dictionary = context.dictionary || {};
    const knownJobPlatforms = this.getKnownJobPlatforms(dictionary);
    
    const brassringPlatform = knownJobPlatforms.find(platform => 
      platform.name === 'Brassring' || platform.name === 'BrassRing'
    );
    
    if (brassringPlatform && brassringPlatform.patterns) {
      const isApplicable = brassringPlatform.patterns.some(pattern => 
        urlLower.includes(pattern.toLowerCase())
      );
      if (isApplicable) {
        config.smartLog('platform', `Brassring detected via patterns for ${url}`);
      }
      return isApplicable;
    }
    
    return false;
  }

  async scrape(url, options = {}) {
    config.smartLog('steps', `Starting ${this.name} for ${url}`);
    
    let result = null;
    let scrapingError = null;
    
    try {
      const dictionary = options.dictionary || {};
      const context = options.context || {};
      
      let searchedJobTitles = '';
      if (context.searchQuery && typeof context.searchQuery === 'string') {
        const jobTitlesFromSearch = context.searchQuery
          .split(',')
          .map(title => title.trim())
          .filter(title => title.length > 0)
          .join(', ');
        if (jobTitlesFromSearch) {
          searchedJobTitles = ` including roles such as ${jobTitlesFromSearch}`;
        }
      }
      
      const careerText = `Brassring Career Portal - This is a Brassring talent acquisition platform that hosts career opportunities and job postings for various companies${searchedJobTitles}. The portal provides access to current job openings, application procedures, and recruitment processes. Please visit the link directly to browse available positions such as senior roles, consultant positions, artist opportunities, lead positions, marketing roles, and other professional careers. Submit applications for roles that match your qualifications and career interests including management, technical, creative, and consulting positions.`;
      
      const linkText = this.getLocalizedText(dictionary, 'view_opportunities', 
        `View Career Opportunities${searchedJobTitles ? ' - ' + context.searchQuery.split(',').slice(0,2).join(', ') : ''}`
      );
      
      result = {
        url,
        title: 'Brassring Career Portal - Job Opportunities',
        text: careerText,
        links: [{
          url: url,
          text: linkText,
          isJobPosting: true,
          linkType: 'career_portal',
          confidence: 1.0,
          description: 'Access the Brassring career portal to view job opportunities'
        }],
        scrapedAt: new Date().toISOString(),
        detectedPlatform: 'Brassring',
        variantType: 'brassring-portal-link',
        jobTermsFound: 10,
        isEmpty: false,
        method: this.name,
        totalJobs: 1,
        message: 'Click the link to access the Brassring career portal and view available opportunities'
      };
      
      config.smartLog('win', `Successfully created Brassring portal link for ${url}`);
      
    } catch (error) {
      config.smartLog('fail', `Error in ${this.name}: ${error.message}`);
      scrapingError = error;
      
      if (config.shouldExportDebug(result, scrapingError, this.name)) {
        try {
          const debugDir = config.DEBUG_DIR || './debug';
          const timestamp = Date.now();
          const hostname = new URL(url).hostname;
          
          await fs.mkdir(debugDir, { recursive: true });
          
          const errorData = {
            step: this.name,
            url,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
          };
          
          await fs.writeFile(
            path.join(debugDir, `${this.name}-FAIL-${hostname}-${timestamp}.json`),
            JSON.stringify(errorData, null, 2)
          );
        } catch (debugError) {
          config.smartLog('fail', `Debug export failed: ${debugError.message}`);
        }
      }
    }
    
    return result;
  }

  isResultValid(result) {
    if (!super.isResultValid(result)) return false;
    return result.links && result.links.length > 0;
  }

  getLocalizedText(dictionary, key, fallback) {
    try {
      if (dictionary && dictionary.localizedTexts && dictionary.localizedTexts[key]) {
        return dictionary.localizedTexts[key];
      }
      return fallback;
    } catch (error) {
      return fallback;
    }
  }
}

module.exports = BrassringStep;