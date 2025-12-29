CREATE TABLE IF NOT EXISTS `licitacao_itens` (
  `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `licitacao_id` varchar(255) NOT NULL,
  `item` varchar(50) NOT NULL,
  `codigo` varchar(100) DEFAULT NULL,
  `descricao` text NOT NULL,
  `unidade` varchar(50) DEFAULT NULL,
  `quantidade` decimal(20,2) DEFAULT NULL,
  `valor_medio` decimal(20,2) DEFAULT NULL,
  `valor_total` decimal(20,2) DEFAULT NULL,
  `lote` varchar(100) DEFAULT NULL,
  `descricao_lote` text DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_licitacao_itens_licitacao` (`licitacao_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `licitacoes` ADD COLUMN IF NOT EXISTS `periodo_lancamento` varchar(255) DEFAULT NULL;
ALTER TABLE `licitacoes` ADD COLUMN IF NOT EXISTS `modo_disputa` varchar(255) DEFAULT NULL;
ALTER TABLE `licitacoes` ADD COLUMN IF NOT EXISTS `valor_previsto` decimal(20,2) DEFAULT NULL;
ALTER TABLE `licitacoes` ADD COLUMN IF NOT EXISTS `registro_precos` tinyint(1) DEFAULT 0;
ALTER TABLE `licitacoes` ADD COLUMN IF NOT EXISTS `obra` tinyint(1) DEFAULT 0;
