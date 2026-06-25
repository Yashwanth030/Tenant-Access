/**
 * SAP Cloud Integration OData v1 resource mappings for MCP tools.
 * Primary names follow SAP Business Accelerator Hub (Cloud Integration API).
 * Fallback names are tried only when the primary returns 404/not implemented.
 *
 * Update this file when you confirm endpoints from SAP cockpit network inspect.
 */

const DEFAULT_QUERY = {
  $format: "json",
  $top: "100"
};

const RESOURCE_REGISTRY = {
  get_security_materials: {
    resources: ["UserCredentials", "OAuth2ClientCredentials", "SecureParameters"],
    queryParams: {
      ...DEFAULT_QUERY,
      $select: "Name,Kind,User,Description,Type,Id"
    },
    itemType: "security-material"
  },
  get_keystores: {
    resources: ["KeystoreEntries", "CertificateUserMappings"],
    queryParams: {
      ...DEFAULT_QUERY,
      $select:
        "Alias,Hexalias,KeyType,ValidNotBefore,ValidNotAfter,Validity,Type,Owner,LastModifiedBy,CreatedBy,Status,SubjectDN,User"
    },
    itemType: "keystore-entry"
  },
  get_pgp_keys: {
    resources: ["PublicKeys", "PGPPublicKeys", "PGPKeys"],
    queryParams: {
      ...DEFAULT_QUERY,
      $select: "UserId,KeyId,KeyID,ValidityState,KeyLength,KeyUsage,KeyCreationDate,KeyExpirationDate,KeyVersion"
    },
    itemType: "pgp-key",
    preferNonEmpty: true,
    emptyMessage:
      "No PGP keys were returned from the tenant OData APIs. Your cockpit may use a keyring-specific Manage PGP Keys service that is not exposed on /api/v1."
  },
  get_access_policies: {
    resources: ["AccessPolicies", "AuthorizationGroups"],
    queryParams: DEFAULT_QUERY,
    itemType: "access-policy"
  },
  get_user_roles: {
    resources: ["UserRoles", "Roles", "CertificateUserMappings"],
    queryParams: DEFAULT_QUERY,
    itemType: "user-role"
  },
  get_data_stores: {
    resources: ["DataStores", "DataStoreEntries"],
    queryParams: DEFAULT_QUERY,
    itemType: "data-store"
  },
  get_variables: {
    resources: ["Variables"],
    queryParams: {
      ...DEFAULT_QUERY,
      $select: "Name,Value,DataType,Id,PackageId,ArtifactId"
    },
    itemType: "variable"
  },
  get_number_ranges: {
    resources: ["NumberRanges"],
    queryParams: DEFAULT_QUERY,
    itemType: "number-range"
  },
  get_partner_directory: {
    resources: ["PartnerDirectoryEntries"],
    queryParams: DEFAULT_QUERY,
    itemType: "partner-directory-entry"
  },
  get_message_locks: {
    resources: ["MessageLocks", "DesigntimeArtifactLocks"],
    queryParams: DEFAULT_QUERY,
    itemType: "message-lock"
  },
  get_system_logs: {
    resources: ["SystemLogFiles", "LogFiles"],
    queryParams: DEFAULT_QUERY,
    itemType: "system-log",
    emptyMessage:
      "System log files are often not exposed through tenant OData. Use SAP cockpit or tenant-specific operations APIs if available."
  },
  get_usage_details: {
    resources: ["UsageDetails", "MessageProcessingStatistics"],
    queryParams: DEFAULT_QUERY,
    itemType: "usage-detail"
  },
  get_connectivity_tests: {
    resources: ["ConnectivityTests", "ServiceEndpoints"],
    queryParams: DEFAULT_QUERY,
    itemType: "connectivity-test"
  },
  get_integration_content: {
    resources: ["IntegrationRuntimeArtifacts", "IntegrationDesigntimeArtifacts"],
    queryParams: {
      ...DEFAULT_QUERY,
      $select: "Id,Name,Version,Type,Status,DeployedBy,DeployedOn,PackageId"
    },
    itemType: "integration-artifact"
  }
};

const getResourceConfig = (toolName) => RESOURCE_REGISTRY[toolName] || null;

module.exports = { RESOURCE_REGISTRY, getResourceConfig, DEFAULT_QUERY };
