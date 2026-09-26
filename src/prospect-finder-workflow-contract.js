'use strict';

/*
 * Lead Recovery Engine — Prospect Finder & Validation V1 — workflow CONTRACT.
 *
 * Single source of truth for the n8n workflow topology: node set, ids,
 * positions, types, connection graph, settings, meta, and every non-code
 * parameter object (Google Sheets reads/writes, provider HTTP nodes, Merge,
 * IF/loop nodes). Code-node jsCode is intentionally NOT here: it lives in
 * src/prospect-finder-embedded-code.js and is injected by
 * scripts/build-prospect-finder-workflow.js.
 *
 * Generated mechanically from the artifact (SHA-256 E7CCCBFB214D8B0425DD0EE697E4F2E1BD5C0496C6ED47BC244838792C14BCB4) on
 * 2026-09-14. Revised for Prompt A.6 (R3): GPL/FSQ error envelopes, Filter
 * Empty Envelopes, Merge numberOfInputs 3 → 5. Revised for Prompt A.9 (R4):
 * D1 Merge mode combine → append (Cartesian product kills error envelopes),
 * D2' Dedup & Prepare Verified gains alwaysOutputData (all-empty loop stall).
 * Revised for Prompt A.10 (R6): D7 Merge numberOfInputs 5 → 3 (one input per
 * provider; success + error paths feed the same input), +OSM Error Envelope.
 * Revised for Prompt A.11 (R7): Process FSQ and Process OSM mirror Process
 * GPL's `_noResults` sentinel on empty success (no structural change — the
 * sentinels live in src/prospect-finder-embedded-code.js).
 * Revised for Prompt A.12 (R8): single canonical phone normalization —
 * `CANONICAL_PHONE_NORMALIZER` injected into Process FSQ and Process OSM
 * (stored phone + dedupe key both canonicalized). No structural change in
 * the contract — the helper lives in src/prospect-finder-embedded-code.js.
 * NOTE: this revision reuses the "R8" label per the user's letter; it is
 * disambiguated from the Prompt C-B row that also used "R8" in the
 * preflight §12.3 revision log (history rows are not renamed).
 * Current artifact SHA-256 is computed by the builder.
 * Node and workflow property ORDER is significant: the builder
 * serializes with JSON.stringify(..., null, 2) with NO trailing newline, and
 * the artifact was produced the same way, so byte-identity depends on
 * preserving key order.
 *
 * The artifact is frozen-by-convention for the GPL workstream. This contract
 * is the regeneration path: edit the spec (or the embedded code), run the
 * builder, then update the hash anchor in
 * tests/prospect-finder-builder.test.js.
 */

const WORKFLOW_NAME = "Lead Recovery Engine — Prospect Finder & Validation V1";
const ARTIFACT = 'Lead Recovery Engine — Prospect Finder & Validation V1';
const SPREADSHEET_ID = '1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ';

const CODE_NODE_NAMES = [
  "Initialize Configuration",
  "Cache Dedup Keys",
  "Filter Pending Searches",
  "Dedup & Prepare Verified",
  "Handle API Error",
  "Process FSQ",
  "Build OSM API Query",
  "Build FSQ API Query",
  "Process OSM",
  "OSM Error Envelope",
  "Prepare Verified Sheet Row",
  "Build GPL API Query",
  "Process GPL",
    "FSQ Error Envelope",
    "GPL Error Envelope",
    "Filter Empty Envelopes",
];

function referenceWorkflow() {
  const nodes = [
    {
        "parameters": {},
        "id": "291c1a70-5de6-4c10-8406-640ecfaedb7d",
        "name": "Manual Trigger",
        "type": "n8n-nodes-base.manualTrigger",
        "typeVersion": 1,
        "position": [
            0,
            0
        ]
    },
    {
        "parameters": {},
        "id": "0004d77d-abf9-46fe-a1e1-b136589138cc",
        "name": "Initialize Configuration",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            224,
            0
        ]
    },
    {
        "parameters": {
            "documentId": {
                "__rl": true,
                "value": "1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ",
                "mode": "list",
                "cachedResultName": "Lead Recovery Engine Prospecting System",
                "cachedResultUrl": "https://docs.google.com/spreadsheets/d/1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ/edit?usp=drivesdk"
            },
            "sheetName": {
                "__rl": true,
                "value": 102,
                "mode": "list",
                "cachedResultName": "Verified Leads",
                "cachedResultUrl": "https://docs.google.com/spreadsheets/d/1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ/edit#gid=102"
            },
            "options": {}
        },
        "id": "5292a8fa-9bdb-4547-8532-4f3e19c3a232",
        "name": "Read Verified Leads",
        "type": "n8n-nodes-base.googleSheets",
        "typeVersion": 4,
        "position": [
            448,
            0
        ],
        "alwaysOutputData": true,
        "credentials": {
            "googleSheetsOAuth2Api": {
                "id": "rOKhG0ESKifN5zy2",
                "name": "Google Sheets account"
            }
        }
    },
    {
        "parameters": {},
        "id": "a064ba34-b487-478e-9e95-8e73a89a2019",
        "name": "Cache Dedup Keys",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            672,
            0
        ]
    },
    {
        "parameters": {
            "documentId": {
                "__rl": true,
                "value": "1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ",
                "mode": "list",
                "cachedResultName": "Lead Recovery Engine Prospecting System",
                "cachedResultUrl": "https://docs.google.com/spreadsheets/d/1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ/edit?usp=drivesdk"
            },
            "sheetName": {
                "__rl": true,
                "value": "gid=0",
                "mode": "list",
                "cachedResultName": "Search Inputs",
                "cachedResultUrl": "https://docs.google.com/spreadsheets/d/1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ/edit#gid=0"
            },
            "options": {}
        },
        "id": "c6525996-d246-472f-b9ab-23da9c262665",
        "name": "Read Search Inputs",
        "type": "n8n-nodes-base.googleSheets",
        "typeVersion": 4,
        "position": [
            880,
            0
        ],
        "credentials": {
            "googleSheetsOAuth2Api": {
                "id": "rOKhG0ESKifN5zy2",
                "name": "Google Sheets account"
            }
        }
    },
    {
        "parameters": {},
        "id": "131e0852-558e-42e6-8665-cfc819d7aa20",
        "name": "Filter Pending Searches",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            1056,
            0
        ]
    },
    {
        "parameters": {
            "conditions": {
                "options": {
                    "caseSensitive": true,
                    "leftValue": "",
                    "typeValidation": "strict",
                    "version": 1
                },
                "conditions": [
                    {
                        "id": "cond-pending-01",
                        "leftValue": "={{ $json._noPending === true }}",
                        "rightValue": true,
                        "operator": {
                            "type": "boolean",
                            "operation": "false",
                            "singleValue": true
                        }
                    }
                ],
                "combinator": "and"
            },
            "options": {}
        },
        "id": "660817d9-2788-4f9a-af9e-dd4d81998380",
        "name": "Has Pending Searches?",
        "type": "n8n-nodes-base.if",
        "typeVersion": 2,
        "position": [
            1248,
            0
        ]
    },
    {
        "parameters": {
            "options": {}
        },
        "id": "d0deb27a-9c7d-4dfa-b7aa-83f56a23f12e",
        "name": "Loop Through Searches",
        "type": "n8n-nodes-base.splitInBatches",
        "typeVersion": 3,
        "position": [
            1440,
            -16
        ]
    },
    {
        "parameters": {
            "operation": "update",
            "documentId": {
                "__rl": true,
                "value": "1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ",
                "mode": "list",
                "cachedResultName": "Lead Recovery Engine Prospecting System",
                "cachedResultUrl": "https://docs.google.com/spreadsheets/d/1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ/edit?usp=drivesdk"
            },
            "sheetName": {
                "__rl": true,
                "value": "gid=0",
                "mode": "list",
                "cachedResultName": "Search Inputs",
                "cachedResultUrl": "https://docs.google.com/spreadsheets/d/1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ/edit#gid=0"
            },
            "columns": {
                "mappingMode": "defineBelow",
                "value": {
                    "input_id": "={{ $json.input_id }}",
                    "niche": "={{ $json.niche }}",
                    "city": "={{ $json.city }}",
                    "state": "={{ $json.state }}",
                    "country": "={{ $json.country }}",
                    "search_query": "={{ $json.search_query }}",
                    "target_count": "={{ $json.target_count }}",
                    "status": "={{ $json.status }}",
                    "priority": "={{ $json.priority }}",
                    "created_at": "={{ $json.created_at }}",
                    "notes": "={{ $json.notes }}"
                },
                "matchingColumns": [
                    "input_id"
                ],
                "schema": [
                    {
                        "id": "input_id",
                        "displayName": "input_id",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "niche",
                        "displayName": "niche",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "city",
                        "displayName": "city",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "state",
                        "displayName": "state",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "country",
                        "displayName": "country",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "search_query",
                        "displayName": "search_query",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "target_count",
                        "displayName": "target_count",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "status",
                        "displayName": "status",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "priority",
                        "displayName": "priority",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "created_at",
                        "displayName": "created_at",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "notes",
                        "displayName": "notes",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "row_number",
                        "displayName": "row_number",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "number",
                        "canBeUsedToMatch": true,
                        "readOnly": true,
                        "removed": true
                    }
                ],
                "attemptToConvertTypes": false,
                "convertFieldsToString": false
            },
            "options": {
                "cellFormat": "USER_ENTERED"
            }
        },
        "id": "5d3308d5-aab8-48a2-bbc2-cb6629190427",
        "name": "Set Status Running",
        "type": "n8n-nodes-base.googleSheets",
        "typeVersion": 4,
        "position": [
            1632,
            0
        ],
        "credentials": {
            "googleSheetsOAuth2Api": {
                "id": "rOKhG0ESKifN5zy2",
                "name": "Google Sheets account"
            }
        }
    },
    {
        "parameters": {
            "conditions": {
                "options": {
                    "caseSensitive": true,
                    "leftValue": "",
                    "typeValidation": "strict",
                    "version": 1
                },
                "conditions": [
                    {
                        "id": "cond-api-01",
                        "leftValue": "={{ $json.statusCode }}",
                        "rightValue": 200,
                        "operator": {
                            "type": "number",
                            "operation": "equals"
                        }
                    }
                ],
                "combinator": "and"
            },
            "options": {}
        },
        "id": "fd969fa1-2136-405d-a113-b93fd0fb8074",
        "name": "API Success?",
        "type": "n8n-nodes-base.if",
        "typeVersion": 2,
        "position": [
            2160,
            96
        ]
    },
    {
        "parameters": {
            "operation": "append",
            "documentId": {
                "__rl": true,
                "value": "1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ",
                "mode": "list",
                "cachedResultName": "Lead Recovery Engine Prospecting System",
                "cachedResultUrl": "https://docs.google.com/spreadsheets/d/1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ/edit?usp=drivesdk"
            },
            "sheetName": {
                "__rl": true,
                "value": 101,
                "mode": "list",
                "cachedResultName": "Raw Leads",
                "cachedResultUrl": "https://docs.google.com/spreadsheets/d/1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ/edit#gid=101"
            },
            "columns": {
                "mappingMode": "defineBelow",
                "value": {
                    "lead_id": "={{ $json.lead_id }}",
                    "business_name": "={{ $json.business_name }}",
                    "niche": "={{ $json.niche }}",
                    "city": "={{ $json.city }}",
                    "state": "={{ $json.state }}",
                    "country": "={{ $json.country }}",
                    "address": "={{ $json.address }}",
                    "phone": "={{ $json.phone }}",
                    "website": "={{ $json.website }}",
                    "rating": "={{ $json.rating }}",
                    "review_count": "={{ $json.review_count }}",
                    "google_maps_url": "={{ $json.google_maps_url }}",
                    "business_type": "={{ $json.business_type }}",
                    "source": "={{ $json.source }}",
                    "search_input_id": "={{ $json.search_input_id }}",
                    "dedupe_key": "={{ $json.dedupe_key }}",
                    "raw_captured_at": "={{ $json.raw_captured_at }}",
                    "notes": "={{ $json.notes }}"
                },
                "matchingColumns": [],
                "schema": [
                    {
                        "id": "lead_id",
                        "displayName": "lead_id",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "business_name",
                        "displayName": "business_name",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "niche",
                        "displayName": "niche",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "city",
                        "displayName": "city",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "state",
                        "displayName": "state",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "country",
                        "displayName": "country",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "address",
                        "displayName": "address",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "phone",
                        "displayName": "phone",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "website",
                        "displayName": "website",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "rating",
                        "displayName": "rating",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "review_count",
                        "displayName": "review_count",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "google_maps_url",
                        "displayName": "google_maps_url",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "business_type",
                        "displayName": "business_type",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "source",
                        "displayName": "source",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "search_input_id",
                        "displayName": "search_input_id",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "dedupe_key",
                        "displayName": "dedupe_key",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "raw_captured_at",
                        "displayName": "raw_captured_at",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "notes",
                        "displayName": "notes",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    }
                ],
                "attemptToConvertTypes": false,
                "convertFieldsToString": false
            },
            "options": {
                "cellFormat": "USER_ENTERED"
            }
        },
        "id": "56ba3719-bdc4-4001-bdae-417e7bcae325",
        "name": "Write Raw Leads",
        "type": "n8n-nodes-base.googleSheets",
        "typeVersion": 4,
        "position": [
            2736,
            0
        ],
        "credentials": {
            "googleSheetsOAuth2Api": {
                "id": "rOKhG0ESKifN5zy2",
                "name": "Google Sheets account"
            }
        }
    },
    {
        "parameters": {},
        "id": "212ae7c6-fc5a-4c34-ac26-e67bb76fb35b",
        "name": "Dedup & Prepare Verified",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            2992,
            0
        ],
        "alwaysOutputData": true
    },
    {
        "parameters": {
            "conditions": {
                "options": {
                    "caseSensitive": true,
                    "leftValue": "",
                    "typeValidation": "strict",
                    "version": 1
                },
                "conditions": [
                    {
                        "id": "cond-ver-01",
                        "leftValue": "={{ $json._noNewVerified }}",
                        "rightValue": true,
                        "operator": {
                            "type": "boolean",
                            "operation": "false",
                            "singleValue": true
                        }
                    }
                ],
                "combinator": "and"
            },
            "options": {}
        },
        "id": "334e7334-d05d-4705-8e5a-b0e9618a51ce",
        "name": "Has New Verified?",
        "type": "n8n-nodes-base.if",
        "typeVersion": 2,
        "position": [
            3264,
            0
        ]
    },
    {
        "parameters": {
            "operation": "append",
            "documentId": {
                "__rl": true,
                "value": "1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ",
                "mode": "list",
                "cachedResultName": "Lead Recovery Engine Prospecting System",
                "cachedResultUrl": "https://docs.google.com/spreadsheets/d/1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ/edit?usp=drivesdk"
            },
            "sheetName": {
                "__rl": true,
                "value": 102,
                "mode": "list",
                "cachedResultName": "Verified Leads",
                "cachedResultUrl": "https://docs.google.com/spreadsheets/d/1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ/edit#gid=102"
            },
            "columns": {
                "mappingMode": "autoMapInputData",
                "value": {
                    "lead_id": "={{ $json.lead_id }}",
                    "business_name": "={{ $json.business_name }}",
                    "niche": "={{ $json.niche }}",
                    "city": "={{ $json.city }}",
                    "state": "={{ $json.state }}",
                    "country": "={{ $json.country }}",
                    "address": "={{ $json.address }}",
                    "phone": "={{ $json.phone }}",
                    "website": "={{ $json.website }}",
                    "rating": "={{ $json.rating }}",
                    "review_count": "={{ $json.review_count }}",
                    "google_maps_url": "={{ $json.google_maps_url }}",
                    "business_type": "={{ $json.business_type }}",
                    "source": "={{ $json.source }}",
                    "search_input_id": "={{ $json.search_input_id }}",
                    "verified_at": "={{ $json.verified_at }}"
                },
                "matchingColumns": [],
                "schema": [
                    {
                        "id": "lead_id",
                        "displayName": "lead_id",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "business_name",
                        "displayName": "business_name",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "niche",
                        "displayName": "niche",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "city",
                        "displayName": "city",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "state",
                        "displayName": "state",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "country",
                        "displayName": "country",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "address",
                        "displayName": "address",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "phone",
                        "displayName": "phone",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "website",
                        "displayName": "website",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "rating",
                        "displayName": "rating",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "review_count",
                        "displayName": "review_count",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "google_maps_url",
                        "displayName": "google_maps_url",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "business_type",
                        "displayName": "business_type",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "source",
                        "displayName": "source",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "search_input_id",
                        "displayName": "search_input_id",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "#REF!",
                        "displayName": "#REF!",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "has_website",
                        "displayName": "has_website",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "has_phone",
                        "displayName": "has_phone",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "target_niche",
                        "displayName": "target_niche",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "score",
                        "displayName": "score",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "qualification_status",
                        "displayName": "qualification_status",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "verified_at",
                        "displayName": "verified_at",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "notes",
                        "displayName": "notes",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "manual_review_notes",
                        "displayName": "manual_review_notes",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    }
                ],
                "attemptToConvertTypes": false,
                "convertFieldsToString": false
            },
            "options": {
                "cellFormat": "USER_ENTERED"
            }
        },
        "id": "e3379688-0e78-4ece-9a82-e39659bf2bef",
        "name": "Write Verified Leads",
        "type": "n8n-nodes-base.googleSheets",
        "typeVersion": 4,
        "position": [
            3600,
            -112
        ],
        "credentials": {
            "googleSheetsOAuth2Api": {
                "id": "rOKhG0ESKifN5zy2",
                "name": "Google Sheets account"
            }
        }
    },
    {
        "parameters": {
            "operation": "update",
            "documentId": {
                "__rl": true,
                "value": "1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ",
                "mode": "list",
                "cachedResultName": "Lead Recovery Engine Prospecting System",
                "cachedResultUrl": "https://docs.google.com/spreadsheets/d/1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ/edit?usp=drivesdk"
            },
            "sheetName": {
                "__rl": true,
                "value": "gid=0",
                "mode": "list",
                "cachedResultName": "Search Inputs",
                "cachedResultUrl": "https://docs.google.com/spreadsheets/d/1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ/edit#gid=0"
            },
            "columns": {
                "mappingMode": "defineBelow",
                "value": {
                    "input_id": "={{ $('Set Status Running').item.json.input_id }}",
                    "status": "Completed"
                },
                "matchingColumns": [
                    "input_id"
                ],
                "schema": [
                    {
                        "id": "input_id",
                        "displayName": "input_id",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "niche",
                        "displayName": "niche",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": true
                    },
                    {
                        "id": "city",
                        "displayName": "city",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": true
                    },
                    {
                        "id": "state",
                        "displayName": "state",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": true
                    },
                    {
                        "id": "country",
                        "displayName": "country",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": true
                    },
                    {
                        "id": "search_query",
                        "displayName": "search_query",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": true
                    },
                    {
                        "id": "target_count",
                        "displayName": "target_count",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": true
                    },
                    {
                        "id": "status",
                        "displayName": "status",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "priority",
                        "displayName": "priority",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": true
                    },
                    {
                        "id": "created_at",
                        "displayName": "created_at",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "notes",
                        "displayName": "notes",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "row_number",
                        "displayName": "row_number",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "number",
                        "canBeUsedToMatch": true,
                        "readOnly": true,
                        "removed": true
                    }
                ],
                "attemptToConvertTypes": false,
                "convertFieldsToString": false
            },
            "options": {
                "cellFormat": "USER_ENTERED"
            }
        },
        "id": "87786833-9812-424f-9173-92a4b64d5518",
        "name": "Update Status Completed",
        "type": "n8n-nodes-base.googleSheets",
        "typeVersion": 4,
        "position": [
            3792,
            80
        ],
        "alwaysOutputData": true,
        "credentials": {
            "googleSheetsOAuth2Api": {
                "id": "rOKhG0ESKifN5zy2",
                "name": "Google Sheets account"
            }
        }
    },
    {
        "parameters": {},
        "id": "a7c3f054-d643-4914-a00c-a869f4af7923",
        "name": "Handle API Error",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            2368,
            256
        ]
    },
    {
        "parameters": {
            "operation": "update",
            "documentId": {
                "__rl": true,
                "value": "1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ",
                "mode": "list",
                "cachedResultName": "Lead Recovery Engine Prospecting System",
                "cachedResultUrl": "https://docs.google.com/spreadsheets/d/1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ/edit?usp=drivesdk"
            },
            "sheetName": {
                "__rl": true,
                "value": "gid=0",
                "mode": "list",
                "cachedResultName": "Search Inputs",
                "cachedResultUrl": "https://docs.google.com/spreadsheets/d/1KN-mAYQnCFJJpHofvDmelGK2eMDyPs-TXVZGMKllHFQ/edit#gid=0"
            },
            "columns": {
                "mappingMode": "defineBelow",
                "value": {
                    "input_id": "={{ $json.input_id }}"
                },
                "matchingColumns": [
                    "input_id"
                ],
                "schema": [
                    {
                        "id": "input_id",
                        "displayName": "input_id",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true,
                        "removed": false
                    },
                    {
                        "id": "niche",
                        "displayName": "niche",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "city",
                        "displayName": "city",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "state",
                        "displayName": "state",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "country",
                        "displayName": "country",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "search_query",
                        "displayName": "search_query",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "target_count",
                        "displayName": "target_count",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "status",
                        "displayName": "status",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "priority",
                        "displayName": "priority",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "created_at",
                        "displayName": "created_at",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "notes",
                        "displayName": "notes",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "string",
                        "canBeUsedToMatch": true
                    },
                    {
                        "id": "row_number",
                        "displayName": "row_number",
                        "required": false,
                        "defaultMatch": false,
                        "display": true,
                        "type": "number",
                        "canBeUsedToMatch": true,
                        "readOnly": true,
                        "removed": true
                    }
                ],
                "attemptToConvertTypes": false,
                "convertFieldsToString": false
            },
            "options": {
                "cellFormat": "USER_ENTERED"
            }
        },
        "id": "ee0e4bef-f30a-454d-a027-19ae735a6e61",
        "name": "Update Status Failed",
        "type": "n8n-nodes-base.googleSheets",
        "typeVersion": 4,
        "position": [
            2608,
            256
        ],
        "credentials": {
            "googleSheetsOAuth2Api": {
                "id": "rOKhG0ESKifN5zy2",
                "name": "Google Sheets account"
            }
        }
    },
    {
        "parameters": {},
        "id": "c11d8285-c0ec-400d-93a5-15e35afa344e",
        "name": "End",
        "type": "n8n-nodes-base.noOp",
        "typeVersion": 1,
        "position": [
            1536,
            304
        ]
    },
    {
        "parameters": {
            "method": "POST",
            "url": "https://overpass.kumi.systems/api/interpreter",
            "sendBody": true,
            "contentType": "form-urlencoded",
            "bodyParameters": {
                "parameters": [
                    {
                        "name": "data",
                        "value": "={{ $json._apiQuery }}"
                    }
                ]
            },
            "options": {
                "response": {
                    "response": {
                        "fullResponse": true
                    }
                }
            }
        },
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.5,
        "position": [
            1984,
            112
        ],
        "id": "fd5b10dc-8c4e-4481-8e33-1c331b0f116f",
        "name": "OpenStreetMap Overpass API",
        "retryOnFail": true,
        "waitBetweenTries": 5000,
        "onError": "continueErrorOutput"
    },
    {
        "parameters": {},
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            2208,
            -80
        ],
        "id": "fd2f9975-644f-4911-bec2-bffec08103b3",
        "name": "Process FSQ",
        "alwaysOutputData": false
    },
    {
        "parameters": {
            "url": "https://places-api.foursquare.com/places/search",
            "sendQuery": true,
            "queryParameters": {
                "parameters": [
                    {
                        "name": "near",
                        "value": "={{$json.fsq_near}}"
                    },
                    {
                        "name": "limit",
                        "value": "={{$json.fsq_limit}}"
                    },
                    {
                        "name": "fields",
                        "value": "fsq_place_id,name,categories,location,tel,website"
                    },
                    {
                        "name": "fsq_category_ids",
                        "value": "={{$json.fsq_category_id}}"
                    }
                ]
            },
            "sendHeaders": true,
            "headerParameters": {
                "parameters": [
                    {
                        "name": "Authorization",
                        "value": "=Bearer {{$credentials.value}}"
                    },
                    {
                        "name": "X-Places-Api-Version",
                        "value": "2025-06-17"
                    }
                ]
            },
            "options": {}
        },
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.5,
        "position": [
            2048,
            -80
        ],
        "credentials": {
            "httpHeaderAuth": {
                "id": "912eb72c-6bd0-42b2-b16e-9ce526d45110",
                "name": "Foursquare API"
            }
        },
        "id": "cfaca348-25c9-41ab-a816-f845b19ed308",
        "name": "Foursquare Places API",
        "onError": "continueErrorOutput"
    },
    {
        "parameters": {},
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            2112,
            96
        ],
        "id": "783a4af2-492e-46c5-b7d7-e0db5bb83089",
        "name": "FSQ Error Envelope"
    },
    {
        "parameters": {},
        "id": "f303a332-b773-4ecf-a854-a550997a05e4",
        "name": "Build OSM API Query",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            1808,
            112
        ]
    },
    {
        "parameters": {},
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            1872,
            -80
        ],
        "id": "19f06e1d-c951-4197-bd77-3d89e6f33383",
        "name": "Build FSQ API Query"
    },
    {
        "parameters": {},
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            2352,
            80
        ],
        "id": "d6a8bd1e-5dca-4d5d-9af2-e05a015885cf",
        "name": "Process OSM"
    },
    {
        "parameters": {},
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            2160,
            176
        ],
        "id": "e0d8f43a-7b21-4c9e-9a56-1f3c0b8d2e77",
        "name": "OSM Error Envelope"
    },
    {
        "parameters": {
            "mode": "append",
            "numberOfInputs": 3
        },
        "type": "n8n-nodes-base.merge",
        "typeVersion": 3.2,
        "position": [
            2512,
            0
        ],
        "id": "c0ec8e86-d057-415f-ba63-7688d693cd1a",
        "name": "Merge"
    },
    {
        "parameters": {},
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            2624,
            0
        ],
        "id": "89ce67c3-af97-4d6c-a2b2-27fd6308c2d4",
        "name": "Filter Empty Envelopes"
    },
    {
        "parameters": {},
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            3440,
            -112
        ],
        "id": "8b407732-b129-410e-9214-cd564ebda967",
        "name": "Prepare Verified Sheet Row"
    },
    {
        "parameters": {},
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            1808,
            -260
        ],
        "id": "0df27b7d-3346-4973-81aa-49c807fb1f3f",
        "name": "Build GPL API Query"
    },
    {
        "parameters": {
            "method": "POST",
            "url": "https://places.googleapis.com/v1/places:searchText",
            "sendBody": true,
            "contentType": "json",
            "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify({ textQuery: $json.gpl_query, maxResultCount: $json.gpl_max_results, languageCode: 'en' }) }}",
            "options": {
                "response": {
                    "response": {
                        "fullResponse": true
                    }
                }
            },
            "sendHeaders": true,
            "headerParameters": {
                "parameters": [
                    {
                        "name": "X-Goog-Api-Key",
                        "value": "={{ $env.GOOGLE_PLACES_API_KEY }}"
                    },
                    {
                        "name": "X-Goog-FieldMask",
                        "value": "places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.googleMapsUri,places.types"
                    }
                ]
            }
        },
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.5,
        "position": [
            1984,
            -260
        ],
        "id": "478ef64d-d584-4435-9575-1c7c2813d16b",
        "name": "Google Places API",
        "retryOnFail": true,
        "waitBetweenTries": 5000,
        "onError": "continueErrorOutput"
    },
    {
        "parameters": {},
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            2160,
            -260
        ],
        "id": "f9584450-bd31-4afe-9a8d-1beba179a548",
        "name": "Process GPL",
        "alwaysOutputData": false
    },
    {
        "parameters": {},
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [
            2112,
            -180
        ],
        "id": "e76f42e8-caf4-4286-80dc-dd4451e701fa",
        "name": "GPL Error Envelope"
    }
];

  const connections = {
    "Manual Trigger": {
        "main": [
            [
                {
                    "node": "Initialize Configuration",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Initialize Configuration": {
        "main": [
            [
                {
                    "node": "Read Verified Leads",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Read Verified Leads": {
        "main": [
            [
                {
                    "node": "Cache Dedup Keys",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Cache Dedup Keys": {
        "main": [
            [
                {
                    "node": "Read Search Inputs",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Read Search Inputs": {
        "main": [
            [
                {
                    "node": "Filter Pending Searches",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Filter Pending Searches": {
        "main": [
            [
                {
                    "node": "Has Pending Searches?",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Has Pending Searches?": {
        "main": [
            [
                {
                    "node": "Loop Through Searches",
                    "type": "main",
                    "index": 0
                }
            ],
            [
                {
                    "node": "End",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Loop Through Searches": {
        "main": [
            [
                {
                    "node": "End",
                    "type": "main",
                    "index": 0
                }
            ],
            [
                {
                    "node": "Set Status Running",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Set Status Running": {
        "main": [
            [
                {
                    "node": "Build FSQ API Query",
                    "type": "main",
                    "index": 0
                },
                {
                    "node": "Build OSM API Query",
                    "type": "main",
                    "index": 0
                },
                {
                    "node": "Build GPL API Query",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "API Success?": {
        "main": [
            [
                {
                    "node": "Process OSM",
                    "type": "main",
                    "index": 0
                }
            ],
            [
                {
                    "node": "OSM Error Envelope",
                    "type": "main",
                    "index": 0
                },
                {
                    "node": "Handle API Error",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Write Raw Leads": {
        "main": [
            [
                {
                    "node": "Dedup & Prepare Verified",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Dedup & Prepare Verified": {
        "main": [
            [
                {
                    "node": "Has New Verified?",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Has New Verified?": {
        "main": [
            [
                {
                    "node": "Prepare Verified Sheet Row",
                    "type": "main",
                    "index": 0
                }
            ],
            [
                {
                    "node": "Update Status Completed",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Write Verified Leads": {
        "main": [
            [
                {
                    "node": "Update Status Completed",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Update Status Completed": {
        "main": [
            [
                {
                    "node": "Loop Through Searches",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Handle API Error": {
        "main": [
            [
                {
                    "node": "Update Status Failed",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Update Status Failed": {
        "main": [
            [
                {
                    "node": "Loop Through Searches",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "OpenStreetMap Overpass API": {
        "main": [
            [
                {
                    "node": "API Success?",
                    "type": "main",
                    "index": 0
                }
            ],
            [
                {
                    "node": "OSM Error Envelope",
                    "type": "main",
                    "index": 0
                },
                {
                    "node": "Handle API Error",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Foursquare Places API": {
        "main": [
            [
                {
                    "node": "Process FSQ",
                    "type": "main",
                    "index": 0
                }
            ],
            [
                {
                    "node": "FSQ Error Envelope",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "FSQ Error Envelope": {
        "main": [
            [
                {
                    "node": "Merge",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Build OSM API Query": {
        "main": [
            [
                {
                    "node": "OpenStreetMap Overpass API",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Build FSQ API Query": {
        "main": [
            [
                {
                    "node": "Foursquare Places API",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Process FSQ": {
        "main": [
            [
                {
                    "node": "Merge",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Process OSM": {
        "main": [
            [
                {
                    "node": "Merge",
                    "type": "main",
                    "index": 1
                }
            ]
        ]
    },
    "OSM Error Envelope": {
        "main": [
            [
                {
                    "node": "Merge",
                    "type": "main",
                    "index": 1
                }
            ]
        ]
    },
    "Merge": {
        "main": [
            [
                {
                    "node": "Filter Empty Envelopes",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Filter Empty Envelopes": {
        "main": [
            [
                {
                    "node": "Write Raw Leads",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Prepare Verified Sheet Row": {
        "main": [
            [
                {
                    "node": "Write Verified Leads",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Build GPL API Query": {
        "main": [
            [
                {
                    "node": "Google Places API",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "Google Places API": {
        "main": [
            [
                {
                    "node": "Process GPL",
                    "type": "main",
                    "index": 0
                }
            ],
            [
                {
                    "node": "GPL Error Envelope",
                    "type": "main",
                    "index": 0
                }
            ]
        ]
    },
    "GPL Error Envelope": {
        "main": [
            [
                {
                    "node": "Merge",
                    "type": "main",
                    "index": 2
                }
            ]
        ]
    },
    "Process GPL": {
        "main": [
            [
                {
                    "node": "Merge",
                    "type": "main",
                    "index": 2
                }
            ]
        ]
    }
};

  return {
    name: WORKFLOW_NAME,
    nodes,
    pinData: {},
    connections,
    active: false,
    settings: {
    "executionOrder": "v1",
    "binaryMode": "separate"
},
    versionId: "d4206a64-3385-4ea8-b8c1-51628540674f",
    meta: {
    "templateCredsSetupCompleted": true,
    "instanceId": "d1a84d17df34e821369daca617638cece9e93450ffc21fa5c85852b78030a55b"
},
    nodeGroups: [],
    id: "WcUgtTPiKXPL0BLH",
    tags: [],
  };
}

module.exports = { WORKFLOW_NAME, ARTIFACT, SPREADSHEET_ID, CODE_NODE_NAMES, referenceWorkflow };
