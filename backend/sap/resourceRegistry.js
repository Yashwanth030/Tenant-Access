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
    queryParams: DEFAULT_QUERY,
    itemType: "security-material",
    preferNonEmpty: true
  },
  get_keystores: {
    resources: ["KeystoreEntries", "CertificateUserMappings"],
    queryParams: {
      keystoreName: "system"
    },
    itemType: "keystore-entry",
    preferNonEmpty: true
  },
  get_pgp_keys: {
    resources: ["PgpKeyEntries", "PublicKeys", "PGPPublicKeys", "PGPKeys"],
    queryParams: {
      keyringName: "pubring"
    },
    itemType: "pgp-key",
    preferNonEmpty: true,
    emptyMessage:
      "No PGP keys were found. Please verify that your PGP keys are configured in the SAP Integration Suite cockpit and that your API user has permissions to view them."
  },
  get_access_policies: {
    resources: ["AccessPolicies", "AuthorizationGroups"],
    queryParams: DEFAULT_QUERY,
    itemType: "access-policy",
    preferNonEmpty: true
  },
  get_user_roles: {
    resources: ["UserRoles", "Roles", "CertificateUserMappings"],
    queryParams: DEFAULT_QUERY,
    itemType: "user-role",
    preferNonEmpty: true
  },
  get_data_stores: {
    resources: ["DataStores", "DataStoreEntries"],
    queryParams: {
      $format: "json"
    },
    itemType: "data-store",
    preferNonEmpty: true
  },
  get_variables: {
    resources: ["Variables"],
    queryParams: {
      $format: "json"
    },
    itemType: "variable"
  },
  get_number_ranges: {
    resources: ["NumberRanges"],
    queryParams: {
      $format: "json"
    },
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
    itemType: "message-lock",
    preferNonEmpty: true
  },
  get_system_logs: {
    resources: ["SystemLogFiles", "LogFiles"],
    queryParams: DEFAULT_QUERY,
    itemType: "system-log",
    preferNonEmpty: true,
    emptyMessage:
      "No system logs were found. Please check your SAP Integration Suite cockpit to access the system log files directly."
  },
  get_usage_details: {
    resources: ["UsageDetails", "MessageProcessingStatistics"],
    queryParams: DEFAULT_QUERY,
    itemType: "usage-detail",
    preferNonEmpty: true
  },
  get_connectivity_tests: {
    resources: ["ConnectivityTests", "ServiceEndpoints"],
    queryParams: DEFAULT_QUERY,
    itemType: "connectivity-test",
    preferNonEmpty: true
  },
  get_integration_content: {
    resources: ["IntegrationRuntimeArtifacts", "IntegrationDesigntimeArtifacts"],
    queryParams: DEFAULT_QUERY,
    itemType: "integration-artifact",
    preferNonEmpty: true
  }
};

const getResourceConfig = (toolName) => RESOURCE_REGISTRY[toolName] || null;

module.exports = { RESOURCE_REGISTRY, getResourceConfig, DEFAULT_QUERY };
