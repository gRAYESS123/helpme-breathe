# .github/workflows/deploy.yml
name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    
    steps:
    - name: Checkout
      uses: actions/checkout@v4
      
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '18'
        cache: 'npm'
        
    - name: Install dependencies
      run: npm ci
      
    - name: Lint code
      run: npm run lint
      
    - name: Build project
      run: npm run build
      
    - name: Run Lighthouse CI
      uses: treosh/lighthouse-ci-action@v10
      with:
        configPath: './lighthouserc.json'
        uploadArtifacts: true
        temporaryPublicStorage: true
        
    - name: Upload artifact
      uses: actions/upload-pages-artifact@v2
      with:
        path: './dist'

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    if: github.ref == 'refs/heads/main'
    
    steps:
    - name: Deploy to GitHub Pages
      id: deployment
      uses: actions/deploy-pages@v2

---
# lighthouserc.json
{
  "ci": {
    "collect": {
      "staticDistDir": "./dist",
      "url": [
        "http://localhost/",
        "http://localhost/?technique=box",
        "http://localhost/?technique=coherent"
      ]
    },
    "assert": {
      "assertions": {
        "categories:performance": ["warn", {"minScore": 0.85}],
        "categories:accessibility": ["error", {"minScore": 0.95}],
        "categories:best-practices": ["warn", {"minScore": 0.90}],
        "categories:seo": ["warn", {"minScore": 0.90}],
        "categories:pwa": ["warn", {"minScore": 0.80}],
        "first-contentful-paint": ["warn", {"maxNumericValue": 2000}],
        "largest-contentful-paint": ["warn", {"maxNumericValue": 4000}],
        "cumulative-layout-shift": ["error", {"maxNumericValue": 0.1}],
        "total-blocking-time": ["warn", {"maxNumericValue": 300}]
      }
    },
    "upload": {
      "target": "temporary-public-storage"
    }
  }
}

---
# .gitignore
# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Build outputs
dist/
build/
.cache/

# Environment files
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# Editor files
.vscode/
.idea/
*.swp
*.swo
*~

# OS files
.DS_Store
Thumbs.db

# Logs
logs/
*.log

# Coverage reports
coverage/
.nyc_output/

# Performance reports
lighthouse-report.html
stats.html

# Temporary files
tmp/
temp/
.tmp/

---
# netlify.toml (if using Netlify)
[build]
  publish = "dist"
  command = "npm run build"

[build.environment]
  NODE_VERSION = "18"

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    X-XSS-Protection = "1; mode=block"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Permissions-Policy = "camera=(), microphone=(), geolocation=()"
    Content-Security-Policy = '''
      default-src 'self';
      script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://pagead2.googlesyndication.com;
      style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
      font-src 'self' https://fonts.gstatic.com;
      img-src 'self' data: https:;
      connect-src 'self' https://www.google-analytics.com;
      media-src 'self';
      worker-src 'self';
      manifest-src 'self';
    '''

[[headers]]
  for = "*.js"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[[headers]]
  for = "*.css"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[[headers]]
  for = "*.woff2"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[[headers]]
  for = "/sw.js"
  [headers.values]
    Cache-Control = "public, max-age=0, must-revalidate"

[[redirects]]
  from = "/breath"
  to = "/"
  status = 301

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200

---
# robots.txt
User-agent: *
Allow: /

# Sitemaps
Sitemap: https://helpmebreath.com/sitemap.xml

# Crawl-delay for respectful crawling
Crawl-delay: 1

# Block admin areas if any
Disallow: /admin/
Disallow: /_*

# Block temporary files
Disallow: /*.tmp
Disallow: /*.temp

---
# sitemap.xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://helpmebreath.com/</loc>
    <lastmod>2024-01-15</lastmod>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://helpmebreath.com/?technique=478</loc>
    <lastmod>2024-01-15</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://helpmebreath.com/?technique=box</loc>
    <lastmod>2024-01-15</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://helpmebreath.com/?technique=coherent</loc>
    <lastmod>2024-01-15</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://helpmebreath.com/?technique=triangle</loc>
    <lastmod>2024-01-15</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://helpmebreath.com/?technique=wim</loc>
    <lastmod>2024-01-15</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://helpmebreath.com/legal/privacy-policy.html</loc>
    <lastmod>2024-01-15</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>https://helpmebreath.com/legal/terms-of-service.html</loc>
    <lastmod>2024-01-15</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
</urlset>

---
# CONTRIBUTING.md
# Contributing to Help Me Breathe

Thank you for your interest in contributing to Help Me Breathe! This document provides guidelines for contributing to the project.

## 🚀 Getting Started

### Prerequisites
- Node.js 18 or higher
- npm or yarn
- Git

### Setup
1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/helpme-breathe.git`
3. Install dependencies: `npm install`
4. Start development server: `npm run dev`

## 🛠️ Development Guidelines

### Code Style
- Use Prettier for formatting (run `npm run format`)
- Follow ESLint rules (run `npm run lint`)
- Use meaningful variable and function names
- Comment complex logic

### Performance Considerations
- Optimize animations for mobile devices
- Use `requestAnimationFrame` for smooth animations
- Implement lazy loading where appropriate
- Minimize DOM manipulations

### Accessibility
- Ensure keyboard navigation works
- Add appropriate ARIA labels
- Test with screen readers
- Maintain proper color contrast

## 📝 Commit Guidelines

Use conventional commits:
- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation changes
- `style:` formatting changes
- `refactor:` code refactoring
- `perf:` performance improvements
- `test:` adding tests

Example: `feat: add heart rate variability breathing technique`

## 🧪 Testing

### Manual Testing
- Test all breathing techniques
- Verify responsive design on mobile
- Check audio functionality
- Test keyboard shortcuts
- Verify PWA installation

### Performance Testing
- Run Lighthouse audits
- Check Core Web Vitals
- Test on slow networks
- Verify offline functionality

## 📋 Pull Request Process

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make your changes following the guidelines
3. Test thoroughly
4. Update documentation if needed
5. Submit a pull request with:
   - Clear description of changes
   - Screenshots for UI changes
   - Performance impact assessment

## 🎨 Design Guidelines

### Visual Design
- Follow the nature-inspired theme
- Use existing color schemes
- Maintain consistency across techniques
- Consider accessibility in color choices

### Animation Principles
- Smooth, natural movements
- Respect user's motion preferences
- Optimize for performance
- Test on various devices

## 🐛 Bug Reports

When reporting bugs, include:
- Browser and version
- Device type
- Steps to reproduce
- Expected vs actual behavior
- Screenshots or recordings

## 💡 Feature Requests

For new features, consider:
- Alignment with app's wellness mission
- Performance impact
- Accessibility implications
- User experience improvements

## 📞 Questions?

- Open an issue for technical questions
- Check existing issues and discussions
- Be respectful and constructive

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for helping make mindful breathing accessible to everyone! 🌙
