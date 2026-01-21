# Use Apify's Playwright image
FROM apify/actor-node-playwright-chrome:18

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev --omit=optional

# Copy source code
COPY . ./

# Run the actor
CMD npm start
