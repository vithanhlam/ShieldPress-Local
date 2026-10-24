<?php
// Read the live ShieldPress config so password and port changes apply
// immediately without writing credentials into /etc/phpmyadmin.
$configPath = $_SERVER['SHIELDPRESS_CONFIG_FILE'] ?? getenv('SHIELDPRESS_CONFIG_FILE');
$appConfig = is_string($configPath) && is_readable($configPath)
    ? json_decode((string) file_get_contents($configPath), true)
    : null;
$mysql = is_array($appConfig) && is_array($appConfig['mysql'] ?? null) ? $appConfig['mysql'] : [];
$rootPassword = (string) ($mysql['root_password'] ?? '');
$cfg['blowfish_secret'] = 'ShieldPressLocal-3307-phpMyAdmin-cookie-secret-2026';
$cfg['Servers'][1] = [
    'auth_type' => 'config',
    'host' => '127.0.0.1',
    'connect_type' => 'tcp',
    'port' => (string) ($mysql['port'] ?? 3307),
    'user' => 'root',
    'password' => $rootPassword,
    'compress' => false,
    'AllowNoPassword' => $rootPassword === '',
];
