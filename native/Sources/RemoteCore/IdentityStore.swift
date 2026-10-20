import Foundation
import IrohLib
import Security

public protocol SecretKeyProviding: Sendable {
    func loadOrCreate() throws -> SecretKey
}

public struct KeychainIdentityStore: SecretKeyProviding, Sendable {
    private let service: String
    private let account: String

    public init(service: String = "com.wisp.remote.identity", account: String = "iroh-endpoint-v1") {
        self.service = service
        self.account = account
    }

    public func loadOrCreate() throws -> SecretKey {
        var query: [String: Any] = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess {
            guard let data = result as? Data, data.count == 32 else {
                throw RemoteError.keychainFailure(errSecDecode)
            }
            do { return try SecretKey.fromBytes(bytes: data) }
            catch { throw RemoteError.keychainFailure(errSecDecode) }
        }
        guard status == errSecItemNotFound else { throw RemoteError.keychainFailure(status) }

        let secret = SecretKey.generate()
        var add = baseQuery
        add[kSecValueData as String] = secret.toBytes()
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(add as CFDictionary, nil)
        if addStatus == errSecDuplicateItem { return try loadOrCreate() }
        guard addStatus == errSecSuccess else { throw RemoteError.keychainFailure(addStatus) }
        return secret
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }
}

public struct EphemeralIdentityStore: SecretKeyProviding, Sendable {
    public init() {}
    public func loadOrCreate() throws -> SecretKey { SecretKey.generate() }
}
