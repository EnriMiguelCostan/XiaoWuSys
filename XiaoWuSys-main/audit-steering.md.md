# Project: XiaoWuSys Comprehensive System Audit (Sprints 1-8)

## Objective
Act as a Senior QA Engineer and Security Auditor. Analyze the existing codebase to identify security vulnerabilities, race conditions, unhandled errors, or architectural gaps specifically within the features completed during Sprints 1 through 8. 

## Strict Constraints
- DO NOT write, edit, refactor, or push any code.
- DO NOT create new files or open any Pull Requests.
- Your output must strictly be a single Markdown report detailing your findings categorized by module.

## Core Requirements for Analysis
1. User Management (PB 1-2): Review the authentication and role-based authorization routes. Are we properly securing passwords/tokens? Are there any endpoints where a 'Staff' user could bypass restrictions to trigger 'Owner' level actions?
2. Core Infrastructure & Sync (PB 3-5): Review the offline SQLite caching, the asynchronous cloud sync to Neon PostgreSQL, and the concurrency conflict override logic. Look for race conditions. How does the system currently handle simultaneous edits from two different staff members? 
3. Order Management Data Entry (PB 6-8): Review the routes for creating order profiles, encoding details, and linking design files. Are inputs properly sanitized to prevent SQL injection? Does the system validate that the "Google Drive link" is an actual URL before saving it to the database?
4. Database Alignment: Compare the backend schema assumptions against the `initLocalDb.js` file. Are there missing columns, undefined relationships, or mismatched data types between the SQLite setup and the routes querying them?