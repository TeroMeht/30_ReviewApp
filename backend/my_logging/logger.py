import logging


def setup_logging(name: str = __name__) -> logging.Logger:
    """
    Configure root logging once and return a module-scoped logger.

    - INFO level for app code
    - Silences noisy third-party loggers (e.g. ib_async)
    """
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(levelname)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Silence ib_async completely — it's chatty and rarely useful.
    ib_logger = logging.getLogger("ib_async")
    ib_logger.addHandler(logging.NullHandler())
    ib_logger.propagate = False
    ib_logger.setLevel(logging.CRITICAL + 1)

    return logging.getLogger(name)
