# RSVP AI Agent Backend

A comprehensive backend API for managing RSVP events with AI-powered voice calling capabilities using ElevenLabs integration. This system allows users to create events, upload participant lists via CSV, trigger automated voice calls to collect RSVPs, and manage document uploads.

## 🚀 Features

- **Event Management**: Create and manage events with participant lists
- **CSV Upload & Processing**: Bulk upload participant data via CSV files
- **AI Voice Calling**: Automated RSVP collection using ElevenLabs AI agents
- **Document Management**: Upload and manage participant documents
- **Credit System**: Track and manage user credits for voice calls
- **Real-time Status Tracking**: Monitor batch call statuses and RSVP responses
- **Supabase Integration**: Robust database and file storage solution

## 🛠️ Tech Stack

- **Runtime**: Node.js with ES Modules
- **Framework**: Express.js
- **Database**: Supabase (PostgreSQL)
- **File Storage**: Supabase Storage
- **AI Integration**: ElevenLabs API
- **File Processing**: Multer, Fast-CSV
- **HTTP Client**: Axios

## 📁 Project Structure

```text
RSVP_AI_AGENT-Backend/
├─ app.js
├─ package.json
├─ package-lock.json
├─ .gitignore
├─ config/
│  └─ supabase.js
├─ controllers/
│  ├─ creditController.js
│  ├─ eventController.js
│  ├─ uploadController.js
│  └─ userController.js
├─ models/
│  ├─ conversationModel.js
│  ├─ eventModel.js
│  └─ userModel.js
├─ routes/
│  ├─ creditRoutes.js
│  ├─ eventRoutes.js
│  ├─ uploadRoutes.js
│  └─ userRoutes.js
├─ utils/
│  └─ elevenlabsApi.js
└─ node_modules/
```

## 📋 Prerequisites

- Node.js (v16 or higher)
- Supabase account and project
- ElevenLabs API account
- Git

## 🔧 Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd RSVP_AI_AGENT-Backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment Setup**
   Create a `.env` file in the root directory:
   ```env
   # Supabase Configuration
   SUPABASE_URL=your_supabase_project_url
   SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
   
   # ElevenLabs Configuration
   ELEVENLABS_API_KEY=your_elevenlabs_api_key
   ELEVENLABS_AGENT_ID=your_elevenlabs_agent_id
   ELEVENLABS_PHONE_NUMBER_ID=your_elevenlabs_phone_number_id
   
   # Server Configuration
   PORT=5000
   NODE_ENV=development
   ```

4. **Database Setup**
   Ensure your Supabase project has the following tables:
   - `users` - User management
   - `events` - Event information
   - `participants` - Event participants
   - `conversation_results` - AI call results
   - `uploads` - Document uploads

5. **Storage Buckets**
   Create the following storage buckets in Supabase:
   - `event-csvs` - For CSV file storage
   - `participant-docs` - For document uploads

## 🚀 Running the Application

```bash
# Development mode
npm start

# The server will start on http://localhost:5000
```

## 📚 API Documentation

### Base URL
```
http://localhost:5000/api
```

### Authentication
Currently, the API uses user_id for identification. Ensure proper authentication is implemented in production.

---

## 👥 User Management

### Create User
```http
POST /api/users
Content-Type: application/json

{
  "user_id": "kp_12345",
  "name": "John Doe",
  "email": "john@example.com"
}
```

### Get All Users
```http
GET /api/users
```

### Get User by ID
```http
GET /api/users/:id
```

### Get User Credits
```http
GET /api/users/:id/credits
```

---

## 📅 Event Management

### Create Event with CSV Upload
```http
POST /api/events
Content-Type: multipart/form-data

Fields:
- user_id: "kp_12345"
- event_name: "Company Annual Meeting"
- event_date: "2024-12-25"
- dataset: [CSV file]
```

**CSV Format Requirements:**
- Must include `Name` column (case-insensitive: name, full_name, fullname)
- Must include `phoneNo` column (case-insensitive: phoneno, phone, phone_number, mobile)
- Optional `email` column (case-insensitive: email, email_address)

### Get Events by User
```http
GET /api/events?user_id=kp_12345
```

### Get Event by ID
```http
GET /api/events/:eventId
```

### Get RSVP Data for Event
```http
GET /api/events/:eventId/rsvps
```

---

## 🤖 AI Voice Calling

### Trigger Batch Call
```http
POST /api/events/:eventId/call-batch
```

### Retry Batch Call
```http
POST /api/events/:eventId/retry-batch
```

### Sync Batch Status
```http
POST /api/events/:eventId/sync-batch-status
```

### Get Batch Status
```http
GET /api/events/:eventId/batch-status
```

---

## 💰 Credit Management

### Reduce Credits After Single Call
```http
POST /api/credits/reduce
Content-Type: application/json

{
  "user_id": "kp_12345",
  "participant_id": "participant_123"
}
```

### Reduce Credits for Batch
```http
POST /api/credits/reduce-batch
Content-Type: application/json

{
  "user_id": "kp_12345",
  "event_id": "event_123"
}
```

### Reduce Credits Using ElevenLabs API
```http
POST /api/credits/reduce-batch-elevenlabs
Content-Type: application/json

{
  "user_id": "kp_12345",
  "batch_id": "elevenlabs_batch_id"
}
```

---

## 📄 Document Management

### Upload Documents
```http
POST /api/uploads
Content-Type: multipart/form-data

Fields:
- participant_id: "participant_123"
- full_name: "John Doe"
- role: "Self" | "Guest"
- document_type: "ID" | "Passport" | "Other"
- file: [document file]
```

### Bulk Upload Documents
```http
POST /api/uploads
Content-Type: multipart/form-data

Fields:
- participant_id: "participant_123"
- members: [JSON array of member objects]
- files: [multiple files]
```

### Get Uploads by Participant
```http
GET /api/uploads/:participant_id
```

### Update Upload
```http
PUT /api/uploads/:uploadId
Content-Type: multipart/form-data

Fields:
- full_name: "Updated Name"
- document_type: "Updated Type"
- file: [new file - optional]
```

---

## 💬 Conversation Management

### Get Conversation Details
```http
GET /api/uploads/conversation/:participantId
```

### Update Conversation
```http
PUT /api/uploads/conversation/:participantId
Content-Type: application/json

{
  "rsvp_status": "yes" | "no" | "maybe",
  "number_of_guests": 2,
  "notes": "Additional notes"
}
```

---

## 🗄️ Database Schema

### Users Table
```sql
- user_id (text, primary key)
- name (text)
- email (text)
- credits (numeric, default: 0)
- created_at (timestamp)
```

### Events Table
```sql
- event_id (uuid, primary key)
- user_id (text, foreign key)
- event_name (text)
- event_date (timestamp)
- uploaded_csv (text, URL)
- status (text, default: "Upcoming")
- batch_id (text)
- batch_status (text)
- created_at (timestamp)
```

### Participants Table
```sql
- participant_id (uuid, primary key)
- event_id (uuid, foreign key)
- user_id (text, foreign key)
- full_name (text)
- phone_number (text)
- email (text)
- uploaded_at (timestamp)
```

### Conversation Results Table
```sql
- conversation_id (text)
- participant_id (uuid, foreign key)
- event_id (uuid, foreign key)
- call_status (text)
- rsvp_status (text)
- number_of_guests (integer)
- notes (text)
- call_duration (integer, seconds)
- proof_uploaded (boolean)
- document_url (text)
- last_updated (timestamp)
```

### Uploads Table
```sql
- upload_id (uuid, primary key)
- participant_id (uuid, foreign key)
- participant_relatives_name (text)
- document_url (text)
- document_type (text)
- role (text)
- proof_uploaded (boolean)
- created_at (timestamp)
```

---

## 🔧 Configuration

### CORS Settings
The application is configured to accept requests from:
- `http://localhost:5173` (development frontend)
- `https://rsvp-ai-agent-frontend.vercel.app` (production frontend)

### File Upload Limits
- Maximum file size: 10MB
- Supported formats: CSV for participant lists, various document formats for uploads

### Credit System
- Credits are charged per minute of voice call duration
- Rate: 1 credit per minute
- Credits are rounded to 2 decimal places for precision

---

## 🚨 Error Handling

The API returns standardized error responses:

```json
{
  "error": "Error message",
  "details": "Additional error details (development only)"
}
```

Common HTTP status codes:
- `200` - Success
- `201` - Created
- `400` - Bad Request
- `404` - Not Found
- `500` - Internal Server Error

---

## 🔍 Logging

The application includes comprehensive logging for:
- API requests and responses
- ElevenLabs API interactions
- Database operations
- File upload processes
- Credit calculations

---

## 🧪 Testing

Currently, no automated tests are configured. To add testing:

1. Install a testing framework (Jest, Mocha, etc.)
2. Create test files in a `tests/` directory
3. Add test scripts to `package.json`

---

## 🚀 Deployment

### Environment Variables for Production
Ensure all environment variables are properly set:
- Use production Supabase credentials
- Use production ElevenLabs API keys
- Set `NODE_ENV=production`
- Configure appropriate `PORT`

### Deployment Platforms
- **Heroku**: Add `Procfile` with `web: node app.js`
- **Railway**: Automatic Node.js detection
- **DigitalOcean App Platform**: Configure build and run commands
- **AWS EC2**: Use PM2 for process management

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📝 License

This project is licensed under the ISC License.

---

## 🆘 Support

For support and questions:
- Create an issue in the repository
- Check the API documentation above
- Review the error logs for debugging

---

## 🔄 Version History

- **v1.0.0** - Initial release with core RSVP functionality
- Features: Event management, CSV processing, AI calling, document uploads, credit system

---

*Built with ❤️ for automated RSVP management*
